## OxoAI 2026.1026.0: first release

Your AI workspace, on your own machine: chat, agents, code, knowledge bases and training, with models that run locally. Free, open source (AGPL-3.0), no online account, no telemetry.

OxoAI is a modified version of [HelixAI](https://github.com/medhiclb/HelixAI) by Medhi Clabaut (Helix Agence). This first release is HelixAI 2026.1024.3 with OxoAI's name, icon and colours, data kept apart from any HelixAI install, and updates from this repository.

### Install (Apple silicon Mac)

One command (recommended), which checks the disk image against `SHA256SUMS.txt` and installs without the macOS warning:

```bash
curl -fsSL https://raw.githubusercontent.com/martinleonardcyber-ops/oxoai/main/scripts/installer-macos.sh | sh
```

Or download `OxoAI-2026.1026.0-arm64.dmg` and drag OxoAI to Applications. The app is not signed by Apple: on first launch, go to System Settings › Privacy & Security and click **Open Anyway**.

On first launch, choose **Standalone machine**: OxoAI installs the LM Studio engine and the best open model that fits your memory (16 GB recommended). Apple silicon only for now; Windows, Linux and Intel Macs will follow.
