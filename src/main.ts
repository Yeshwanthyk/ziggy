const usage = `ziggy — a folder that is an assistant

usage:
  ziggy init <name|path>      create a profile (SOUL.md)
  ziggy <name|path>           open the profile in the TUI
  ziggy run <name|path> <prompt>   one-shot answer against the profile
  ziggy profiles              list profiles in ~/.ziggy/profiles`;

const command = process.argv[2];

switch (command) {
  case "init":
  case "run":
  case "profiles":
    console.log(`not implemented: ${command}`);
    process.exitCode = 1;
    break;
  case undefined:
    console.log(usage);
    process.exitCode = 1;
    break;
  default:
    console.log(`not implemented: ${command}`);
    process.exitCode = 1;
}
