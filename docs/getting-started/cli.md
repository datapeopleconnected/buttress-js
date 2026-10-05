# CLI

The Buttress CLI helps you manage apps and resources from the terminal.

## Install

```bash
npm i -g @buttress/cli
```

## Verify Installation

```bash
bjs help
```

## Connect to an Instance

```bash
# bjs connect <url> <super-token> <app-code>
bjs connect http://localhost:8000 <SUPER_TOKEN> buttressjs
```

List and select saved connections:

```bash
bjs list
bjs connection 0
```

## Common Commands

```bash
bjs app create -n "My App" --path "my-app"
bjs policy create --filePath="./policy.json"
bjs lambda create --filePath="./lambda.json"
bjs secure-store create --filePath="./secure-store.json"
```

## Notes

- Prefer using app tokens for daily operations instead of super tokens.
- Keep token values out of shell history in shared environments.
- Run `bjs <resource> help` for resource-specific options.
