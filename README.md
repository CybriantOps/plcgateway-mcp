# PLCGateway MCP

Connect AI assistants to your plant through [PLCGateway](https://plcgateway.com).

PLCGateway connects PLCs, CNC machines and controllers (Siemens S7, Modbus, Mitsubishi, Omron, Allen-Bradley, OPC UA and more), and
every PLCGateway product has an **MCP server built in**. This package is a small **stdio bridge**: MCP clients that start servers as a
command (Claude Desktop, Cursor, Cline, Windsurf, …) run it, and it forwards everything to *your* PLCGateway on your network.

```
AI client ──stdio──▶ @plcgateway/mcp ──HTTP (your network)──▶ PLCGateway on your premises ──▶ PLCs & machines
```

- PLCGateway runs on your premises. The bridge talks only to the address you give it; it collects nothing and sends nothing elsewhere.
- The assistant works with the rights of the token you give it, the same roles as people.

## What you can ask

- "How many alarms did line 3 have in the last 2 hours?"
- "What was the filler's OEE today, and where did we lose the most time?"
- "Summarise the last 24 hours of the tank level trend."
- "Build a report dashboard with production and energy per shift for line 1." *(draft for you to review)*
- "Add the Modbus TCP meter at 192.168.1.40 as 'Compressor 2 energy meter'." *(needs the MCP configuration token)*

## Requirements

- PLCGateway SCADA or Connect, reachable from the computer running the AI client, with MCP enabled
- An **API token**: PLCGateway → Settings → API token (operator rights: read, write, alarm acknowledgement)
- Node.js 18.17 or newer

For setup work (adding devices and tags) create the **MCP configuration token** in Settings and switch it off when done.

## Setup

### Claude Desktop, Cursor, Cline and other stdio clients

```json
{
  "mcpServers": {
    "plcgateway": {
      "command": "npx",
      "args": ["-y", "@plcgateway/mcp"],
      "env": {
        "PLCGATEWAY_URL": "http://192.168.1.50:8080",
        "PLCGATEWAY_TOKEN": "<your API token>"
      }
    }
  }
}
```

### Clients that support HTTP MCP directly

You don't need this package; connect straight to PLCGateway:

```json
{ "mcpServers": { "plcgateway": { "type": "http", "url": "http://192.168.1.50:8080/mcp",
                                   "headers": { "Authorization": "Bearer <your API token>" } } } }
```

### On the PLCGateway computer itself

`plcgateway-scada --mcp-stdio` (or `plcgateway-connect --mcp-stdio`) can be added as the command directly.

## Configuration

| Variable | Flag | Description |
|---|---|---|
| `PLCGATEWAY_URL` | `--url` | PLCGateway address, e.g. `http://192.168.1.50:8080` (`/mcp` is added if missing) |
| `PLCGATEWAY_TOKEN` | `--token` | API token or MCP configuration token. Prefer the environment variable. |
| `PLCGATEWAY_TIMEOUT` | `--timeout` | Request timeout in seconds (default 120) |

For HTTPS with your own certificate authority, set `NODE_EXTRA_CA_CERTS=/path/to/ca.pem`.

## Troubleshooting

The bridge logs to stderr (visible in your client's MCP logs).

| Message | What to check |
|---|---|
| `PLCGateway not reachable` | Address and port, firewall, PLCGateway running |
| `HTTP 401/403` | The token (Settings → API token); a regenerated token replaces the old one |
| `HTTP 404` | MCP is disabled in PLCGateway settings, or the URL points elsewhere |

## Links

- Product: https://plcgateway.com · AI and MCP: https://plcgateway.com/ai-mcp
- Demo: https://plcgateway.com/contact

## License

The bridge in this repository is MIT licensed. PLCGateway itself is proprietary software, licensed separately.
