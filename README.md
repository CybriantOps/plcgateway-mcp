# PLCGateway MCP

[![npm](https://img.shields.io/npm/v/@plcgateway/mcp)](https://www.npmjs.com/package/@plcgateway/mcp)
[![CI](https://github.com/CybriantOps/plcgateway-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/CybriantOps/plcgateway-mcp/actions/workflows/ci.yml)
[![PLCGateway MCP server](https://glama.ai/mcp/servers/CybriantOps/plcgateway-mcp/badges/score.svg)](https://glama.ai/mcp/servers/CybriantOps/plcgateway-mcp)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![node](https://img.shields.io/node/v/@plcgateway/mcp)](package.json)

**MCP server for PLCs, CNC machines and SCADA.** Ask an AI assistant about live machine data, alarms, history and OEE,
and let it add devices, tags, screens and reports, on your own network.

[PLCGateway](https://plcgateway.com) is PLC gateway and SCADA software: it connects PLCs, CNC machines and controllers
(Siemens S7, Modbus, Mitsubishi, Omron, Allen-Bradley, FANUC, OPC UA and more) and shares their data over OPC UA, MQTT,
Modbus TCP and REST. Every PLCGateway product has an **MCP server built in**. This package is a small **stdio bridge**:
MCP clients that start servers as a command (Claude Desktop, Claude Code, Cursor, Cline, Windsurf, …) run it, and it
forwards everything to *your* PLCGateway on your network.

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

## Tools

The tools come from the PLCGateway you connect to, so the list follows your edition and the rights of your token.

| Group | Tools |
|---|---|
| Context | `get_site_context`, `system_status`, `help`, `list_protocols` |
| Data | `list_devices`, `list_tags`, `read_tags`, `query_history`, `write_tag` |
| Alarms | `active_alarms`, `alarm_history`, `alarm_stats`, `acknowledge_alarm`, `list_alarm_definitions` |
| Production | `calculate_oee`, `get_production_kpis`, `list_production_assets`, `list_batches`, `list_production_batches`, `set_batch_result` |
| Screens and reports | `list_screens`, `get_screen`, `list_symbols`, `create_screen_draft`, `create_dashboard_draft`, `generate_report` |
| Configuration (admin) | `set_site_profile`, `test_device`, `create_device`, `update_device`, `create_tags`, `update_tags`, `define_production_asset`, `define_products`, OPC UA certificate actions |

Full description: https://plcgateway.com/ai-mcp

## Supported devices and protocols

All drivers are included in every licence, with no device or tag limit:

Siemens S7 · Modbus TCP/RTU · Mitsubishi MC · Omron FINS · Allen-Bradley EtherNet/IP · Beckhoff ADS · FANUC FOCAS ·
OPC UA and DA · IEC 60870-5-104 · IEC 61850 · DNP3 · BACnet

Data goes out over an OPC UA server, MQTT, a Modbus TCP server and a REST API. Details: https://plcgateway.com/protocols

## Safety

- **On your premises.** PLCGateway sends nothing to a cloud by itself; tool results go only to the assistant you connect.
  With a self-hosted model the data stays in your network.
- **Same roles as people.** Viewer, operator and administrator rights apply to the assistant. Writing a value needs
  operator rights; configuration needs an administrator session, a local connection or the configuration token.
- **Drafts, not live changes.** Screens and dashboards an assistant creates are drafts that a person reviews.
- **Audit trail.** Every write is logged with the user's name.

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

### Claude Code

```sh
claude mcp add --transport stdio \
  --env PLCGATEWAY_URL=http://192.168.1.50:8080 \
  --env PLCGATEWAY_TOKEN=<your API token> \
  plcgateway -- npx -y @plcgateway/mcp
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

If PLCGateway cannot be reached when the client connects, the bridge stays up in **offline mode** with a single tool,
`connection_status`. Ask the assistant "why is PLCGateway not connected?" and it reports the reason. The bridge retries
by itself, and the plant tools appear once PLCGateway answers.

| Message | What to check |
|---|---|
| `PLCGateway not reachable` | Address and port, firewall, PLCGateway running |
| `HTTP 401/403` | The token (Settings → API token); a regenerated token replaces the old one |
| `HTTP 404` | MCP is disabled in PLCGateway settings, or the URL points elsewhere |

## Getting PLCGateway

- **30-day trial** of every product and module, no licence needed: https://plcgateway.com/contact
- **Pricing**: one-time licence per computer, MCP server included in every edition: https://plcgateway.com/pricing

## Links

- Product: https://plcgateway.com
- AI and MCP: https://plcgateway.com/ai-mcp
- Supported protocols: https://plcgateway.com/protocols
- npm: https://www.npmjs.com/package/@plcgateway/mcp
- Issues with the bridge: https://github.com/CybriantOps/plcgateway-mcp/issues

## License

The bridge in this repository is MIT licensed. PLCGateway itself is proprietary software, licensed separately.
