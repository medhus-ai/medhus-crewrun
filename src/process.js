import { spawn } from "node:child_process";

export function runProcess(command, args = [], options = {}) {
  const {
    timeout = 30000,
    maxBuffer = 10 * 1024 * 1024,
    ...spawnOptions
  } = options;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        ...spawnOptions
      });
    } catch (error) {
      resolve({ status: null, stdout: "", stderr: "", error });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, ...result });
    };
    const append = (stream, chunk) => {
      if (stream === "stdout") stdout += String(chunk || "");
      else stderr += String(chunk || "");
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) <= maxBuffer) return;
      const error = new Error(`${command} output exceeded ${maxBuffer} bytes`);
      error.code = "ENOBUFS";
      child.kill();
      finish({ status: null, error });
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => append("stdout", chunk));
    child.stderr?.on("data", (chunk) => append("stderr", chunk));
    child.once("error", (error) => finish({ status: null, error }));
    child.once("close", (status, signal) => finish({ status, signal, error: null }));

    if (Number(timeout) > 0) {
      timer = setTimeout(() => {
        const error = new Error(`${command} timed out after ${timeout}ms`);
        error.code = "ETIMEDOUT";
        child.kill();
        finish({ status: null, error });
      }, Number(timeout));
      timer.unref?.();
    }
  });
}
