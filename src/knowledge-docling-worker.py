"""Bounded, model-free Docling conversion. No URLs, plugins, OCR, macros or remote services."""
import json
from importlib.metadata import version
from pathlib import Path
from zipfile import ZipFile, is_zipfile

from docling.datamodel.base_models import InputFormat
from docling.document_converter import DocumentConverter, NativePdfFormatOption

if version("docling-slim") != "2.126.0":
    raise RuntimeError("Install the verified Docling version")

source = next(Path("/work/input").iterdir())
if is_zipfile(source):
    with ZipFile(source) as archive:
        entries = archive.infolist()
        if len(entries) > 10000 or sum(e.file_size for e in entries) > 64000000:
            raise ValueError("Office archive exceeds conversion limits")

converter = DocumentConverter(
    allowed_formats=[InputFormat.DOCX, InputFormat.XLSX, InputFormat.PPTX, InputFormat.CSV, InputFormat.PDF],
    format_options={InputFormat.PDF: NativePdfFormatOption()},
)
result = converter.convert(source, max_num_pages=100, max_file_size=10000000)
if result.status.value != "success":
    raise ValueError("Document conversion incomplete")
document = result.document
text = document.export_to_markdown()
if not text.strip() or len(text.encode("utf-8")) > 2000000:
    raise ValueError("Document is empty, needs OCR, or exceeds extracted-text limits")
# Docling references/pages identify extracted elements, not invented Excel A1 addresses.
references = [{"ref": item.self_ref, "pages": sorted({p.page_no for p in item.prov})}
              for item, _ in document.iterate_items() if getattr(item, "prov", None)][:1000]
print(json.dumps({"content": text, "references": references}, ensure_ascii=True))
