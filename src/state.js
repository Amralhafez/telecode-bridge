const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "state.json");
const DEFAULT_WORKSPACE = process.env.WORKSPACE_DIR || "C:\\Users\\you\\TeleCode";

const defaults = {
  ownerId: null,
  chatId: null,
  activeRepo: null,
  repos: {},
  activeSessions: {},
  lastSessionLists: {},
  activeModels: {},
  activeAgents: {}
};

let state = { ...defaults };

function migrate(data) {
  if (data.activeSessionId && !data.repos) {
    data.repos = { telecode: { dir: DEFAULT_WORKSPACE, port: 4096 } };
    data.activeRepo = "telecode";
    data.activeSessions = { telecode: data.activeSessionId };
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
  if (!Object.keys(data.repos).length) {
    data.repos.telecode = { dir: DEFAULT_WORKSPACE, port: 4096 };
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
