const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "state.json");
// Workspace to operate on by default. Set WORKSPACE_DIR in .env; otherwise
// fall back to the directory the bridge was started from. No OS-specific paths.
const DEFAULT_WORKSPACE = process.env.WORKSPACE_DIR || process.cwd();
// Internal label for the default repo, derived from the workspace folder name.
const DEFAULT_REPO =
  (path.basename(DEFAULT_WORKSPACE) || "workspace").toLowerCase().replace(/[^a-z0-9-]/g, "") || "workspace";

const defaults = {
  ownerId: null,
  chatId: null,
  activeRepo: null,
  repos: {},
  activeSessions: {},
  lastSessionLists: {},
  activeModels: {},
  activeAgents: {},
  yolo: {},
  schedules: [],
  allowedUsers: [],
  budgetLimit: 0
};

let state = { ...defaults };

function migrate(data) {
  if (data.activeSessionId && !data.repos) {
    data.repos = { [DEFAULT_REPO]: { dir: DEFAULT_WORKSPACE, port: 4096 } };
    data.activeRepo = DEFAULT_REPO;
    data.activeSessions = { [DEFAULT_REPO]: data.activeSessionId };
    data.lastSessionLists = {};
    data.activeModels = {};
    data.activeAgents = {};
    delete data.activeSessionId;
    delete data.lastSessionList;
  }
  data.repos = data.repos || {};
  data.activeSessions = data.activeSessions || {};
  data.lastSessionLists = data.lastSessionLists || {};
  data.activeModels = data.activeModels || {};
  data.activeAgents = data.activeAgents || {};
  data.yolo = data.yolo || {};
  data.schedules = Array.isArray(data.schedules) ? data.schedules : [];
  data.allowedUsers = Array.isArray(data.allowedUsers) ? data.allowedUsers : [];
  data.budgetLimit = Number(data.budgetLimit) || 0;
  if (!Object.keys(data.repos).length) {
    data.repos[DEFAULT_REPO] = { dir: DEFAULT_WORKSPACE, port: 4096 };
    delete data.activeSessionId;
  }
  if (!data.activeRepo || !data.repos[data.activeRepo]) {
    data.activeRepo = Object.keys(data.repos)[0];
  }
  return data;
}

function load() {
  try {
    state = migrate({ ...defaults, ...JSON.parse(fs.readFileSync(FILE, "utf8")) });
  } catch {
    state = migrate({ ...defaults });
  }
  save();
  return state;
}

function save() {
  const tmp = FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, FILE);
}

function get() {
  return state;
}

function set(patch) {
  Object.assign(state, patch);
  save();
  return state;
}

module.exports = { load, save, get, set };
