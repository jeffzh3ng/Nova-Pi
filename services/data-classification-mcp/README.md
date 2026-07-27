# Data Classification MCP

This is the independent MCP service behind the Nova data classification digital human.

It supports:

- source data asset parsing
- built-in and custom classification matrix handling
- local rule screening
- model-backed semantic review through a configurable OpenAI-compatible API
- standard MCP clients through Python FastMCP

## Install

```bash
cd services/data-classification-mcp
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
```

Copy `config.example.json` to `config.local.json` and adjust model API settings and key environment names.

## Run As A Standard MCP Server

Stdio, suitable for most MCP desktop clients:

```bash
python server.py --transport stdio
```

Streamable HTTP for a local long-running service:

```bash
python server.py --transport streamable-http --host 127.0.0.1 --port 8766
```

Bind HTTP to localhost unless there is a deliberate gateway in front of it. Do not put API keys in client prompts; use environment variables or `config.local.json`.

## Configure Nova

Nova connects to this service as an external MCP client. Open Nova settings and enable **Data Classification MCP**.

For stdio, set the MCP path to this service file and use the standard transport argument:

```bash
D:\PROGRAMS\RUST\Nova\services\data-classification-mcp\server.py
--transport stdio
```

For HTTP, run the service first and set Nova's HTTP MCP address to:

```bash
http://127.0.0.1:8766/mcp
```

Nova stores the MCP connection settings in its local `nova.sqlite3` database. The service's own model API and API key stay in `config.local.json` or environment variables so other MCP clients can use the same service independently.

## Tools

- `classify_data_assets`
