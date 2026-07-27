# Threat Analysis MCP

This is the independent MCP service behind the Nova threat-analysis digital human.

It supports:

- security alert and packet-analysis triage
- PCAP parsing through configurable Wireshark/tshark paths
- alert screenshot OCR through a configurable OCR command
- attack IP threat-intelligence lookup through ThreatBook
- standard MCP clients through Python FastMCP

## Install

```bash
cd services/alert-analysis-mcp
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
```

Copy `config.example.json` to `config.local.json` and adjust model, API key env names, ThreatBook key env names, and Wireshark tool paths.

Image alert recognition does not require a vision-capable LLM. Install an OCR engine such as Tesseract and configure `ocr.tesseractPath`; the MCP extracts text from screenshots first, then sends the text to the normal alert-analysis tool.

## Run As A Standard MCP Server

Stdio, suitable for most MCP desktop clients:

```bash
python server.py --transport stdio
```

Streamable HTTP for a local long-running service:

```bash
python server.py --transport streamable-http --host 127.0.0.1 --port 8765
```

Bind HTTP to localhost unless there is a deliberate gateway in front of it. Do not put API keys in client prompts; use environment variables or `config.local.json`.

## Configure Nova

Nova connects to this service as an external MCP client. Open Nova settings and enable **Threat Analysis MCP**.

For stdio, set the MCP path to this service file and use the standard transport argument:

```bash
D:\PROGRAMS\RUST\Nova\services\alert-analysis-mcp\server.py
--transport stdio
```

For HTTP, run the service first and set Nova's HTTP MCP address to:

```bash
http://127.0.0.1:8765/mcp
```

Nova stores the MCP connection settings in its local `nova.sqlite3` database. The service's own model API, API key, ThreatBook key, and Wireshark paths remain in `config.local.json` or environment variables so other MCP clients can use the same service independently.

## Tools

- `analyze_security_alert`
- `analyze_attack_ip`
- `parse_pcap_file`
- `extract_alert_image`

ThreatBook lookup reads `THREATBOOK_API_KEY` or the local service configuration. Client requests cannot override this operator secret.
