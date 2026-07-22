# Multiversa Installer

Instalador visual multiplataforma de Multiversa.Lab. Es una interfaz Tauri fina
sobre el CLI `multiversa`: detecta el entorno, negocia capacidades y crea un
Project OS único sin implementar una segunda lógica de manifests o vault.

## Contrato

- Requiere un CLI que declare Profile `0.3-read-write` mediante
  `multiversa capabilities --json`.
- Los secretos viajan por stdin al vault; nunca forman parte de argumentos o logs.
- No contiene templates, perfiles ni nombres de OS de clientes.
- El trabajo comercial y los datos privados pertenecen a Multiversa.Group.

## Desarrollo

```bash
pnpm install --frozen-lockfile
pnpm tauri dev
pnpm tauri build
```

Los builds de Linux, macOS y Windows se verifican en GitHub Actions. Los bundles
de release se publican únicamente desde tags firmados y con checksums.
