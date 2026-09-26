use std::{
    env,
    error::Error,
    path::PathBuf,
    process::{Command, Stdio},
};

fn launch_mode(args: &[String]) -> Result<(&str, Option<&str>), String> {
    let mut mode = "ensure";
    let mut workspace = None;
    let mut selected = false;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--workspace" => {
                index += 1;
                workspace = Some(args.get(index).ok_or("--workspace needs a path")?.as_str());
            }
            flag => {
                if selected {
                    return Err("Choose one launch mode".into());
                }
                mode = match flag {
                    "--headless" => "serve",
                    "--status" => "status",
                    "--stop" => "stop",
                    "--login" => "login",
                    "--doctor" => "doctor",
                    "--help" => "help",
                    "--smoke-window" => "smoke-window",
                    _ => return Err(format!("Unknown option: {flag}")),
                };
                selected = true;
            }
        }
        index += 1;
    }
    Ok((mode, workspace))
}

fn payload() -> Result<PathBuf, Box<dyn Error>> {
    let exe = env::current_exe()?;
    let parent = exe.parent().ok_or("Missing app directory")?;
    // Portable archive, macOS .app, then Linux bundle resource layout.
    let mut candidates = vec![
        parent.join("payload"),
        parent.join("../Resources/payload"),
        parent.join("../lib/crewrun-app/payload"),
        parent.join("../lib/CrewRun/payload"),
    ];
    if cfg!(debug_assertions) {
        candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("payload"));
    }
    candidates
        .into_iter()
        .find(|p| p.join("manifest.json").is_file())
        .ok_or("Packaged runtime missing; keep the app beside its payload directory".into())
}

fn runtime_command(payload: &std::path::Path, mode: &str, workspace: Option<&str>) -> Command {
    let mut command =
        Command::new(
            payload
                .join("runtime")
                .join(if cfg!(windows) { "node.exe" } else { "node" }),
        );
    command
        .arg(payload.join("app/node_modules/medhus-crewrun/bin/crewrun-app.js"))
        .arg(mode);
    if let Some(root) = workspace {
        command.arg(root);
    }
    command.env_remove("NODE_OPTIONS").env_remove("NODE_PATH");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        if mode == "ensure" {
            command.creation_flags(0x08000000);
        }
    }
    command
}

fn main() {
    if let Err(error) = run() {
        eprintln!("CrewRun: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn Error>> {
    let args: Vec<String> = env::args().skip(1).collect();
    let (mode, workspace) = launch_mode(&args)?;
    if mode == "help" {
        println!("CrewRun [--workspace PATH] [--headless | --status | --stop | --login | --doctor]\nDefault: desktop window. Closing the window leaves work running. --headless runs in the foreground without a display; use your OS service manager for autostart.");
        return Ok(());
    }
    let payload = payload()?;
    if mode != "ensure" && mode != "smoke-window" {
        let status = runtime_command(&payload, mode, workspace)
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .status()?;
        std::process::exit(status.code().unwrap_or(1));
    }
    #[cfg(not(feature = "desktop"))]
    return Err("This headless build has no renderer. Use --headless or a desktop build.".into());
    #[cfg(feature = "desktop")]
    {
        let result = runtime_command(&payload, "ensure", workspace).output()?;
        if !result.status.success() {
            return Err(String::from_utf8_lossy(&result.stderr).into_owned().into());
        }
        let attachment: serde_json::Value = serde_json::from_slice(&result.stdout)?;
        desktop(attachment, mode == "smoke-window")
    }
}

#[cfg(feature = "desktop")]
fn desktop(attachment: serde_json::Value, smoke: bool) -> Result<(), Box<dyn Error>> {
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
    if attachment["protocol"] != 1 {
        return Err("Unsupported runner attachment protocol".into());
    }
    let url: tauri::Url = attachment["url"]
        .as_str()
        .ok_or("Missing console URL")?
        .parse()?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Desktop only attaches to the authenticated local runner".into());
    }
    let name = attachment["cookie"]["name"]
        .as_str()
        .ok_or("Missing session name")?
        .to_owned();
    let value = attachment["cookie"]["value"]
        .as_str()
        .ok_or("Missing session")?
        .to_owned();
    tauri::Builder::default()
        .setup(move |app| {
            if smoke {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(20));
                    handle.exit(1);
                });
            }
            let origin = url.origin();
            let window = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External(url.join("/_crew/connecting")?),
            )
            .title("CrewRun — background runner stays active when this window closes")
            .inner_size(1200.0, 820.0)
            .min_inner_size(760.0, 520.0)
            .on_page_load(move |window, payload| {
                if smoke
                    && payload.url().path() == "/"
                    && payload.event() == tauri::webview::PageLoadEvent::Finished
                {
                    let handle = window.app_handle().clone();
                    let _ = window.eval_with_callback("document.body.innerText", move |text| {
                        if text.contains("Dashboard") {
                            println!("CrewRun desktop rendered authenticated Dashboard");
                            handle.exit(0);
                        } else {
                            eprintln!("Desktop did not render the authenticated console");
                            handle.exit(1);
                        }
                    });
                }
            })
            .on_navigation(move |target| {
                if target.origin() == origin {
                    return true;
                }
                // Only provider consent origins can leave the app. No renderer IPC or shell API.
                if target.scheme() == "https"
                    && matches!(
                        target.host_str(),
                        Some(
                            "accounts.google.com"
                                | "login.microsoftonline.com"
                                | "slack.com"
                                | "github.com"
                        )
                    )
                {
                    let _ = open::that(target.as_str());
                }
                false
            })
            .build()?;
            let cookie = tauri::webview::Cookie::build((name, value))
                .domain("127.0.0.1")
                .path("/")
                .http_only(true)
                .same_site(cookie::SameSite::Strict)
                .build();
            window.set_cookie(cookie)?;
            window.navigate(url)?;
            Ok(())
        })
        .run(tauri::generate_context!())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_modes_and_paths_do_not_become_shell_commands() {
        let args = vec![
            "--headless".into(),
            "--workspace".into(),
            "folder with ü & spaces".into(),
        ];
        assert_eq!(
            launch_mode(&args).unwrap(),
            ("serve", Some("folder with ü & spaces"))
        );
        assert!(launch_mode(&["--public".into()]).is_err());
        assert!(launch_mode(&["--headless".into(), "--stop".into()]).is_err());
        assert!(launch_mode(&["--workspace".into()]).is_err());
        assert_eq!(launch_mode(&[]).unwrap(), ("ensure", None));
    }
}
