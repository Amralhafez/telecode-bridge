const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "state.json");

const defaults = {
  ownerId: null,
  chatId: null,
  activeSessionId: null,
  lastSessionList: []
};

let state = { ...defaults };

function load() {
  try {
    state = { ...defaults, ...JSON.parse(fs.readFileSync(FILE, "utf8")) };
  } catch {
    state = { ...defaults };
  }
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
