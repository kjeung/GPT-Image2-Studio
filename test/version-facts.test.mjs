import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAINTAINED_VERSION_FACT_TEMPLATES,
  findVersionFactDrift,
  getMaintainedVersionFactTemplates,
  renderVersionFact,
  replaceVersionFacts,
} from "../scripts/version-facts.mjs";
import { checkReleaseReadiness } from "../scripts/check-release-readiness.mjs";
import { bumpPatchRelease } from "../scripts/release-patch.mjs";

const README_TEMPLATES = getMaintainedVersionFactTemplates("README.md");
const BADGE_TEMPLATE = "version-v{version}-2563eb.svg";

test("maintained version facts cover the installer and release-note link", () => {
  const ZH_README_TEMPLATES = getMaintainedVersionFactTemplates("README.zh-CN.md");
  assert.ok(ZH_README_TEMPLATES.includes("GPT-Image2-Studio-Setup-v{version}.exe"));
  assert.ok(README_TEMPLATES.includes("[v{version}](./docs/releases/v{version}.md)"));
  // The shields badge is the first version fact a reader sees, so it must be maintained too.
  assert.ok(README_TEMPLATES.includes(BADGE_TEMPLATE));
  assert.ok(ZH_README_TEMPLATES.includes(BADGE_TEMPLATE));
  assert.equal(getMaintainedVersionFactTemplates("does/not/exist.md").length, 0);
  for (const { templates } of MAINTAINED_VERSION_FACT_TEMPLATES) {
    for (const template of templates) {
      assert.ok(template.includes("{version}"), `${template} must carry a version hole`);
    }
  }
});

test("drift detection reports stale facts and ignores absent or current ones", () => {
  const stale = [
    "Current version: `v1.2.003`",
    "Download `GPT-Image2-Studio-Setup-v1.2.003.exe` today.",
    "- Current release notes: [v1.2.002](./docs/releases/v1.2.002.md).",
  ].join("\n");

  const drift = findVersionFactDrift({ text: stale, templates: README_TEMPLATES, version: "1.2.003" });
  assert.equal(drift.length, 1);
  assert.equal(drift[0].found, "[v1.2.002](./docs/releases/v1.2.002.md)");
  assert.equal(drift[0].expected, "[v1.2.003](./docs/releases/v1.2.003.md)");
  assert.equal(drift[0].lineNumber, 3);

  // The shields badge is a version fact like any other; a stale one is drift.
  const staleBadge = findVersionFactDrift({
    text: "[![Version](https://img.shields.io/badge/version-v1.2.003-2563eb.svg)](https://example.test/releases)\n",
    templates: README_TEMPLATES,
    version: "1.2.004",
  });
  assert.equal(staleBadge.length, 1);
  assert.equal(staleBadge[0].found, "version-v1.2.003-2563eb.svg");

  // A document that never mentions a template is unconstrained by it.
  assert.equal(findVersionFactDrift({ text: "no facts here\n", templates: README_TEMPLATES, version: "1.2.003" }).length, 0);

  // A link naming two versions is drift even when only one half is stale.
  const link = findVersionFactDrift({
    text: "- Current release notes: [v1.2.003](./docs/releases/v1.2.002.md).\n",
    templates: README_TEMPLATES,
    version: "1.2.003",
  });
  assert.equal(link.length, 1);
});

test("fact replacement never bleeds into a longer version or into prose", () => {
  const source = [
    "- Current release notes: [v1.2.003](./docs/releases/v1.2.003.md).",
    "- Previous release notes: [v1.2.030](./docs/releases/v1.2.030.md) stays on its own version.",
    "Historical releases: v1.2.003 and v1.2.030.",
    "Example command: `git tag v1.2.003`.",
  ].join("\n");

  const { text, replaced } = replaceVersionFacts({
    text: source,
    templates: README_TEMPLATES,
    previousVersion: "1.2.003",
    version: "1.2.004",
  });

  assert.equal(replaced, 1);
  assert.ok(text.includes("[v1.2.004](./docs/releases/v1.2.004.md)"));
  assert.ok(text.includes("[v1.2.030](./docs/releases/v1.2.030.md)"), "a longer version must not be rewritten");
  assert.ok(text.includes("Historical releases: v1.2.003 and v1.2.030."), "prose must stay byte-for-byte");
  assert.ok(text.includes("`git tag v1.2.003`"), "tag examples must stay byte-for-byte");
  assert.equal(renderVersionFact("v{version}", "9.9.9"), "v9.9.9");
});

async function createReleaseFixture(version) {
  const root = await mkdtemp(join(tmpdir(), "image-studio-version-facts-"));
  await mkdir(join(root, "docs", "releases"), { recursive: true });
  await mkdir(join(root, "public"), { recursive: true });
  await writeFile(join(root, "package.json"), `{"version":"${version}"}\n`, "utf8");
  await writeFile(
    join(root, "package-lock.json"),
    `{"version":"${version}","packages":{"":{"version":"${version}"}}}\n`,
    "utf8",
  );
  await writeFile(
    join(root, "README.md"),
    `Current version: \`v${version}\`\n\n[![Version](https://img.shields.io/badge/version-v${version}-2563eb.svg)](https://example.test/releases)\n\n- Current release notes: [v${version}](./docs/releases/v${version}.md)\n`,
    "utf8",
  );
  await writeFile(join(root, "README.zh-CN.md"), `当前版本：\`v${version}\`\n`, "utf8");
  await writeFile(
    join(root, "docs", "windows-installer.md"),
    `\`GPT-Image2-Studio-Setup-v${version}.exe\` 是兼容安装包。\n`,
    "utf8",
  );
  await writeFile(
    join(root, "public", "index.html"),
    `<small class="app-version" aria-label="当前版本 v${version}">v${version}</small>\n`,
    "utf8",
  );
  await writeFile(join(root, "docs", "releases", `v${version}.md`), `# GPT-Image2-Studio v${version}\n`, "utf8");
  return root;
}

test("release readiness rejects a stale release-note link that the anchored fact cannot catch", async () => {
  const root = await createReleaseFixture("1.2.003");

  // The anchored `Current version:` fact is correct; only the release-note link lagged behind.
  // This is exactly the drift that used to pass every check.
  await writeFile(
    join(root, "README.md"),
    "Current version: `v1.2.003`\n\n- Current release notes: [v1.2.002](./docs/releases/v1.2.002.md)\n",
    "utf8",
  );
  await assert.rejects(checkReleaseReadiness({ rootDir: root }), /README\.md.*v1\.2\.002/s);

  await writeFile(
    join(root, "README.md"),
    "Current version: `v1.2.003`\n\n- Current release notes: [v1.2.003](./docs/releases/v1.2.003.md)\n",
    "utf8",
  );
  const result = await checkReleaseReadiness({ rootDir: root });
  assert.equal(result.versionLabel, "v1.2.003");
});

test("patch release updates the release-note link alongside the anchored fact", async () => {
  const root = await createReleaseFixture("1.2.003");

  const result = await bumpPatchRelease({ rootDir: root, summary: "同步版本事实。" });
  assert.equal(result.version, "1.2.004");

  const readme = await readFile(join(root, "README.md"), "utf8");
  assert.ok(readme.includes("Current version: `v1.2.004`"));
  assert.ok(readme.includes("[v1.2.004](./docs/releases/v1.2.004.md)"), "the release-note link must follow the bump");
  assert.ok(
    readme.includes("https://img.shields.io/badge/version-v1.2.004-2563eb.svg"),
    "the shields badge must follow the bump",
  );
  assert.equal(readme.includes("v1.2.003"), false);

  const installerDoc = await readFile(join(root, "docs", "windows-installer.md"), "utf8");
  assert.ok(installerDoc.includes("GPT-Image2-Studio-Setup-v1.2.004.exe"));

  // The freshly bumped tree must satisfy the check that previously missed the unanchored fact.
  const check = await checkReleaseReadiness({ rootDir: root });
  assert.equal(check.versionLabel, "v1.2.004");
});
