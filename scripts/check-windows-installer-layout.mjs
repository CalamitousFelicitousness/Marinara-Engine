import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const installerPath = resolve(REPO_ROOT, "win/installer/installer.nsi");
const sharedPackagePath = resolve(REPO_ROOT, "packages/shared/package.json");

try {
  const [content, sharedPackageSource] = await Promise.all([
    readFile(installerPath, "utf8"),
    readFile(sharedPackagePath, "utf8"),
  ]);
  const sharedPackage = JSON.parse(sharedPackageSource);
  const lines = content.split(/\r?\n/);
  const code = lines.map((line) => (/^\s*;/.test(line) ? "" : line)).join("\n");

  const unsafePatterns = [
    {
      pattern: /\bgit clone\b[^\r\n]*"?\$INSTDIR\\repo-temp"?/i,
      message: 'Initial clone target must not be under "$INSTDIR".',
    },
    {
      pattern: /\brobocopy\s+"?\$INSTDIR\\repo-temp"?\s+"?\$INSTDIR"?\b/i,
      message: 'Do not robocopy from "$INSTDIR\\repo-temp" into its parent "$INSTDIR".',
    },
    {
      pattern:
        /\bStrCpy\s+\$[A-Za-z0-9_]+\s+(?:"\$TEMP\\MarinaraEngine-repo-temp"|\$TEMP\\MarinaraEngine-repo-temp)\s*(?:\r?\n|$)/i,
      message: 'Temporary clone paths must include a per-run suffix, not fixed "$TEMP\\MarinaraEngine-repo-temp".',
    },
    {
      pattern: /\bStrCpy\s+\$[A-Za-z0-9_]+\s+(?:"\$INSTDIR\.__stage"|\$INSTDIR\.__stage)\s*(?:\r?\n|$)/i,
      message: 'Temporary stage paths must include a per-run suffix, not fixed "$INSTDIR.__stage".',
    },
  ];

  const failures = unsafePatterns.filter(({ pattern }) => pattern.test(code));
  // #7933: nsExec and cmd.exe stripped the nested download quotes before PowerShell parsed them.
  // Exercise the exact command line on Windows, with network and signature APIs stubbed.
  const prerequisiteLines = lines.filter((line) => /nsExec::ExecToLog.*powershell/i.test(line));
  const prerequisiteScripts = prerequisiteLines.map(
    (line) => /^\s*nsExec::ExecToLog `powershell -NoProfile -Command "([^"\r\n]+)"`$/.exec(line)?.[1],
  );
  if (prerequisiteScripts.length !== 4 || prerequisiteScripts.some((script) => !script)) {
    failures.push({
      message: "Prerequisite PowerShell commands must run directly with one intact quoted script argument.",
    });
  } else {
    const executable = process.platform === "win32" ? "powershell.exe" : "pwsh";
    const probe = spawnSync(executable, ["-NoProfile", "-Command", "exit 0"], { windowsHide: true });
    if (probe.error?.code === "ENOENT" && process.platform !== "win32") {
      console.log("PowerShell unavailable; native prerequisite command proof runs in the Windows platform check.");
    } else {
      assert.equal(probe.status, 0, `PowerShell must be available: ${probe.error ?? probe.stderr}`);
      // Windows PowerShell expands 8.3 aliases such as RUNNER~1; compare the same canonical directory.
      const temp = await realpath(await mkdtemp(resolve(tmpdir(), "Marinara O'Brien & (prereq) ")));
      try {
        const definitions = new Map(
          [...content.matchAll(/^!define (\w+) "([^"\r\n]+)"$/gm)].map((match) => match.slice(1)),
        );
        const preamble =
          [
            "$ErrorActionPreference = 'Stop'",
            "function Invoke-WebRequest { param($Uri, $OutFile, [switch]$UseBasicParsing); if ($Uri -ne $env:MARINARA_EXPECT_URI -or $OutFile -ne $env:MARINARA_EXPECT_FILE -or !$UseBasicParsing) { throw ('Unexpected download arguments: URI=' + $Uri + '; expected URI=' + $env:MARINARA_EXPECT_URI + '; file=' + $OutFile + '; expected file=' + $env:MARINARA_EXPECT_FILE + '; basic parsing=' + $UseBasicParsing) }; Write-Host 'download-stub' }",
            "function Get-FileHash { param($Algorithm, $LiteralPath); if ($Algorithm -ne 'SHA256' -or $LiteralPath -ne $env:MARINARA_EXPECT_FILE) { throw 'Unexpected hash arguments' }; Write-Host 'hash-stub'; @{ Hash = $env:MARINARA_STUB_HASH } }",
            "function Get-AuthenticodeSignature { param($LiteralPath); if ($LiteralPath -ne $env:MARINARA_EXPECT_FILE) { throw 'Unexpected signature path' }; Write-Host 'signature-stub'; @{ Status = $env:MARINARA_STUB_SIGNATURE } }",
          ].join("; ") + "; ";
        for (const [index, script] of prerequisiteScripts.entries()) {
          const isGit = index < 2;
          const name = isGit ? "GIT" : "NODE";
          const expanded = script.replace(/\$\{(\w+)\}/g, (_, key) => {
            assert.ok(definitions.has(key), `Unknown installer definition ${key}`);
            return definitions.get(key);
          });
          const env = {
            ...process.env,
            TMP: temp,
            TEMP: temp,
            TMPDIR: temp,
            MARINARA_EXPECT_URI: definitions.get(`${name}_DOWNLOAD_URL`),
            MARINARA_EXPECT_FILE: resolve(temp, isGit ? "git-install.exe" : "node-install.msi"),
            MARINARA_STUB_HASH: definitions.get(`${name}_SHA256`),
            MARINARA_STUB_SIGNATURE: "Valid",
          };
          const run = (overrides = {}) => {
            const command = preamble + expanded;
            const args =
              process.platform === "win32" ? [`-NoProfile -Command "${command}"`] : ["-NoProfile", "-Command", command];
            return spawnSync(executable, args, {
              env: { ...env, ...overrides },
              encoding: "utf8",
              timeout: 15_000,
              windowsHide: true,
              windowsVerbatimArguments: process.platform === "win32",
            });
          };
          const valid = run();
          assert.equal(valid.status, 0, `${name} prerequisite command failed: ${valid.error ?? valid.stderr}`);
          if (index % 2 === 0) {
            assert.match(valid.stdout, /download-stub/, `${name} download command must reach Invoke-WebRequest`);
          } else {
            assert.match(valid.stdout, /hash-stub[\s\S]*signature-stub/, `${name} must verify hash before signature`);
            const badHash = run({ MARINARA_STUB_HASH: "0".repeat(64) });
            assert.equal(badHash.status, 1, `${name} must refuse a mismatched hash`);
            assert.doesNotMatch(badHash.stdout, /signature-stub/, `${name} must stop at a mismatched hash`);
            const badSignature = run({ MARINARA_STUB_SIGNATURE: "NotSigned" });
            assert.equal(badSignature.status, 1, `${name} must refuse an invalid signature`);
            assert.match(badSignature.stdout, /signature-stub/, `${name} must reach signature verification`);
          }
        }
        console.log("Git and Node.js PowerShell prerequisite commands passed positive and integrity-failure controls.");
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
    }
  }
  const sharedBuild = sharedPackage?.scripts?.build;
  if (typeof sharedBuild !== "string" || /\bpnpm(?:\.cmd)?\s/i.test(sharedBuild)) {
    failures.push({
      message:
        "The shared workspace build must not invoke nested pnpm; Windows Corepack-only launchers do not put a global pnpm executable on PATH.",
    });
  }
  const npmFallbackStart = code.indexOf('DetailPrint "Temporary pnpm unavailable;');
  const npmFallbackEnd = code.indexOf(
    'MessageBox MB_OK|MB_ICONSTOP "pnpm ${PNPM_VERSION} could not be',
    npmFallbackStart,
  );
  const npmFallback =
    npmFallbackStart >= 0 && npmFallbackEnd > npmFallbackStart ? code.slice(npmFallbackStart, npmFallbackEnd) : "";
  const npmFallbackSequence = [
    "npm install --global pnpm@${PNPM_VERSION}",
    "npm config get prefix",
    '${StrTrimNewLines} $NPM_PREFIX "$NPM_PREFIX"',
    't "$NPM_PREFIX;$1"',
    "cmd /d /c pnpm --version",
  ];
  let previousFallbackStep = -1;
  const npmFallbackIsOrdered = npmFallbackSequence.every((step) => {
    const position = npmFallback.indexOf(step);
    if (position <= previousFallbackStep) return false;
    previousFallbackStep = position;
    return true;
  });
  if (!npmFallbackIsOrdered) {
    failures.push({
      message:
        "The Windows installer must install pinned pnpm, resolve and trim npm's prefix, update PATH, then verify pnpm in order.",
    });
  }
  if (npmFallback.includes('t "$APPDATA\\npm;$1"')) {
    failures.push({
      message: "The Windows installer must not assume the default npm prefix; custom global prefixes must work.",
    });
  }

  const pnpmCheckStart = code.indexOf('DetailPrint "Ensuring pnpm ${PNPM_VERSION}..."');
  const pnpmCheckEnd = code.indexOf('DetailPrint "pnpm ready."', pnpmCheckStart);
  const pnpmChecks =
    pnpmCheckStart >= 0 && pnpmCheckEnd > pnpmCheckStart ? code.slice(pnpmCheckStart, pnpmCheckEnd) : "";
  const normalizedVersionChecks = pnpmChecks.match(
    /\$\{StrTrimNewLines\} \$CURRENT_PNPM_VERSION "\$CURRENT_PNPM_VERSION"/g,
  );
  const exactVersionChecks = pnpmChecks.match(/\$\{If\} \$CURRENT_PNPM_VERSION == "\$\{PNPM_VERSION\}"/g);
  if (/\bfindstr(?:\.exe)?\b/i.test(pnpmChecks)) {
    failures.push({
      message: "pnpm version checks must not use findstr; LF-only output can make exact-line matching fail.",
    });
  }
  if (normalizedVersionChecks?.length !== 4 || exactVersionChecks?.length !== 4) {
    failures.push({
      message: "Every Windows installer pnpm runner must capture, trim, and compare its reported version exactly.",
    });
  }
  // #6984: ExecToStack keeps git's trailing newline. An untrimmed HEAD never equaled the trimmed
  // release commit, so every update of an existing install stopped with "did not land on the expected commit".
  const commitReads = code.match(/nsExec::ExecToStack '[^'\n]*git rev-parse[^'\n]*'/g) ?? [];
  const trimmedCommitReads =
    code.match(
      /nsExec::ExecToStack '[^'\n]*git rev-parse[^'\n]*'\s+Pop \$\w+\s+Pop (\$\w+)\s+\$\{StrTrimNewLines\} \1 "\1"/g,
    ) ?? [];
  if (commitReads.length === 0 || trimmedCommitReads.length !== commitReads.length) {
    failures.push({
      message:
        "Every commit the Windows installer reads with nsExec::ExecToStack must be trimmed before it is compared.",
    });
  }

  const uninstallStart = code.indexOf('Section "Uninstall"');
  const packageRemoval = code.indexOf('RMDir /r "$INSTDIR\\packages"', uninstallStart);
  const canonicalDataDecision = code.indexOf("$INSTDIR\\packages\\server\\data", uninstallStart);
  if (uninstallStart < 0 || packageRemoval < 0 || canonicalDataDecision < 0 || canonicalDataDecision > packageRemoval) {
    failures.push({
      message:
        'The uninstaller must decide how to preserve "$INSTDIR\\packages\\server\\data" before removing packages.',
    });
  }
  if (!code.includes('Rename "$INSTDIR\\packages\\server\\data" "$INSTDIR\\.__marinara-preserved-data"')) {
    failures.push({ message: "The uninstaller must move current-layout user data out of packages before cleanup." });
  }
  if (!code.includes('Rename "$INSTDIR\\.__marinara-preserved-data" "$INSTDIR\\packages\\server\\data"')) {
    failures.push({ message: "The uninstaller must restore preserved current-layout user data after cleanup." });
  }
  const interruptedDataDecision = code.indexOf(
    '${ElseIf} ${FileExists} "$INSTDIR\\.__marinara-preserved-data\\*.*"',
    uninstallStart,
  );
  if (interruptedDataDecision < 0 || interruptedDataDecision > packageRemoval) {
    failures.push({ message: "The uninstaller must detect data staged by an interrupted previous uninstall." });
  }
  if (!code.includes('RMDir /r "$INSTDIR\\.__marinara-preserved-data"')) {
    failures.push({ message: "The delete-data path must remove data staged by an interrupted previous uninstall." });
  }
  if (/RMDir\s+\/r\s+"\$INSTDIR\\installer"/i.test(code)) {
    failures.push({ message: 'The uninstaller still targets the stale "$INSTDIR\\installer" directory.' });
  }
  if (!/RMDir\s+\/r\s+"\$INSTDIR\\win"/i.test(code)) {
    failures.push({ message: 'The uninstaller must remove the current "$INSTDIR\\win" directory.' });
  }

  const unsafeVariableAssignments = [
    {
      pattern: /\bStrCpy\s+(\$[A-Za-z0-9_]+)\s+"?\$INSTDIR\\repo-temp"?\b/i,
      message: (variable) => `Temporary clone variable ${variable} must not point under "$INSTDIR".`,
    },
    {
      pattern: /\b(?:SetEnv|SetEnvironmentVariable)\s+(\$[A-Za-z0-9_]+)\s+"?\$INSTDIR\\repo-temp"?\b/i,
      message: (variable) => `Environment staging variable ${variable} must not point under "$INSTDIR".`,
    },
  ];

  const unsafeVariables = new Map();
  for (const line of lines) {
    const codeLine = /^\s*;/.test(line) ? "" : line;
    for (const { pattern, message } of unsafeVariableAssignments) {
      const match = pattern.exec(codeLine);
      if (match) {
        const variable = match[1].toUpperCase();
        unsafeVariables.set(variable, message(match[1]));
      }
    }
  }

  for (const message of unsafeVariables.values()) {
    failures.push({ message });
  }

  for (const [variable] of unsafeVariables) {
    const escapedVariable = variable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const unsafeVariableUse = new RegExp(`\\b(?:git clone|robocopy)\\b[^\\r\\n]*"?${escapedVariable}"?\\b`, "i");
    if (unsafeVariableUse.test(code)) {
      failures.push({
        message: `Do not use ${variable} as a git clone or robocopy source after assigning it under "$INSTDIR".`,
      });
    }
  }

  if (failures.length > 0) {
    console.error("Unsafe Windows installer staging layout detected:");
    for (const failure of failures) {
      console.error(`- ${failure.message}`);
    }
    console.error("Stage repository clones outside the final install directory.");
    process.exit(1);
  }

  console.log("Windows installer layout and Corepack launcher compatibility are safe.");
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
