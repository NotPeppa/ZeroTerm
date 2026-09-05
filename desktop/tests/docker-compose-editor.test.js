// Regression checks for opening Compose config files from Docker project groups.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../frontend/main.js"), "utf8");
const start = source.indexOf("function dockerProjectFiles");
const end = source.indexOf("\nasync function dockerComposeAction", start);

if (start < 0 || end < 0) {
  throw new Error("Docker Compose file helpers were not found");
}

function helpersFor(rows) {
  return vm.runInNewContext(
    `${source.slice(start, end)}; ({ dockerProjectFiles, dockerComposeArgs })`,
    { dockerLastRows: rows },
  );
}

function assertJson(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: got ${JSON.stringify(actual)}`);
  }
}

function run() {
  const relative = helpersFor([{
    project: "demo",
    configFiles: "compose.yml,compose.prod.yml",
    workingDir: "/srv/demo",
  }]);
  assertJson(
    Array.from(relative.dockerProjectFiles("demo")),
    ["/srv/demo/compose.yml", "/srv/demo/compose.prod.yml"],
    "relative Compose files should resolve from the project directory",
  );
  assertJson(
    Array.from(relative.dockerComposeArgs("demo", "up")),
    [
      "compose", "--project-name", "demo", "--project-directory", "/srv/demo",
      "--file", "/srv/demo/compose.yml", "--file", "/srv/demo/compose.prod.yml", "up", "-d",
    ],
    "up should keep every Compose file",
  );

  const absolute = helpersFor([{
    project: "demo",
    configFiles: "/opt/app/compose.yaml,C:\\app\\compose.override.yaml",
    workingDir: "/ignored",
  }]);
  assertJson(
    Array.from(absolute.dockerProjectFiles("demo")),
    ["/opt/app/compose.yaml", "C:\\app\\compose.override.yaml"],
    "absolute POSIX and Windows paths should remain unchanged",
  );

  if (!source.includes('button[data-compose-file]') || !source.includes("openFileEditorAtPath(pane, path)")) {
    throw new Error("Compose file menu action is not wired to the shared file editor");
  }

  console.log("docker-compose-editor.test.js: passed");
}

run();
