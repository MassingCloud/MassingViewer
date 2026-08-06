// Fail the install with a fixable message rather than a mystery build break.
//
// massing's #1 contributor-onboarding failure is a Node 18 earlier on PATH than Node 24: the install
// succeeds, and then `vite build` dies somewhere deep with an error that names neither Node nor the
// version. `engines` alone does not catch it, because npm's engine check is advisory unless
// `engine-strict` is set AND the failure message still doesn't say what to do about it. Six lines here
// buy a sentence the next person can act on.

const REQUIRED_MAJOR = 24;
const major = Number(process.versions.node.split(".")[0]);

if (!Number.isFinite(major) || major < REQUIRED_MAJOR) {
  const onWindows = process.platform === "win32";
  const fix = onWindows
    ? `  export PATH="/c/Program Files/nodejs:$PATH"    # Git Bash / MSYS\n  $env:PATH = "C:\\Program Files\\nodejs;$env:PATH"  # PowerShell`
    : `  nvm use            # reads .nvmrc\n  # or: fnm use / asdf install`;

  process.stderr.write(
    `\nMassingViewer needs Node ${REQUIRED_MAJOR} or newer. Found ${process.versions.node} at:\n` +
      `  ${process.execPath}\n\n` +
      `Vite 8 and @thatopen/fragments both break on older Node, usually with an error that mentions\n` +
      `neither. Put Node ${REQUIRED_MAJOR} first on PATH:\n\n${fix}\n\n` +
      `Then re-run \`npm install\`. See CONTRIBUTING.md.\n\n`,
  );
  process.exit(1);
}
