# Voice Capture Example

A worked example of SwarmVault's local-Whisper audio pipeline. Ingests a voice memo end-to-end with no API keys and no network calls.

## Prerequisites

1. **whisper.cpp binary** on `$PATH`:
   - macOS: `brew install whisper-cpp`
   - Debian / Ubuntu: `sudo apt install whisper.cpp` (or build from [ggerganov/whisper.cpp](https://github.com/ggerganov/whisper.cpp))
   - SwarmVault searches for `whisper-cli`, `whisper-cpp`, or `whisper` in that order; override with `SWARMVAULT_WHISPER_BINARY` or `localWhisper.binaryPath` in `swarmvault.config.json`.
2. **A Whisper ggml model** — `swarmvault provider setup --local-whisper` downloads `base.en` (~147 MB) into `~/.swarmvault/models/` by default. Pick a different tier with `--model {tiny.en,small.en,medium.en,large-v3}`.

## Walkthrough

```bash
# 1. Create a fresh vault for this example
mkdir -p /tmp/voice-capture-demo && cd /tmp/voice-capture-demo
swarmvault init

# 2. Install the local-Whisper provider and download the model
swarmvault provider setup --local-whisper --apply

# 3. Make a short sample audio file (or drop in your own .wav/.mp3/.m4a)
say -o sample.aiff "The quarterly review with Dana covered hiring, revenue, and the Q3 pilot with Acme."
ffmpeg -y -i sample.aiff -ac 1 -ar 16000 sample.wav   # optional resample; whisper.cpp accepts many formats
# or, on Linux: espeak -w sample.wav "The quarterly review ..."

# 4. Ingest the audio — transcription runs through local-whisper, derived text
#    is redacted, and a source page lands in wiki/.
swarmvault add sample.wav
swarmvault compile

# 5. Query the new page
swarmvault query "What did Dana cover in the quarterly review?"
```

The compiled source page carries `providerId: local-whisper`, `providerModel: base.en`, and — when a graph exists — a `metadata.corpus_hint` field showing the domain hint that was forwarded to whisper.cpp. Built-in secret redaction applies to the transcribed text the same way it does to any other extracted text, so API keys or tokens that slip into a voice memo are scrubbed before they reach `raw/` or `wiki/`.

## Notes

- The first transcription warms whisper.cpp's model cache; subsequent runs are faster.
- `base.en` transcribes ~3-5x realtime on a modern laptop. For longer recordings or higher accuracy, try `small.en` or `medium.en` and increase `localWhisper.threads`.
- This example does **not** commit a binary fixture — generate one with the `say` / `ffmpeg` / `espeak` lines above, or point `swarmvault add` at any audio file on disk.
