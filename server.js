require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || "change_this_admin_key";
const ROBLOX_API_KEY = process.env.ROBLOX_API_KEY || "change_this_roblox_key";

const DB_PATH = path.join(__dirname, "data", "database.json");

const WEBHOOKS = {
  announcements: process.env.WEBHOOK_ANNOUNCEMENTS || "",
  changelogs: process.env.WEBHOOK_CHANGELOGS || "",
  reports: process.env.WEBHOOK_REPORTS || "",
  staffLogs: process.env.WEBHOOK_STAFF_LOGS || "",
  whitelist: process.env.WEBHOOK_WHITELIST || "",
  policeLogs: process.env.WEBHOOK_POLICE_LOGS || "",
  factionLogs: process.env.WEBHOOK_FACTION_LOGS || "",
  inventoryLogs: process.env.WEBHOOK_INVENTORY_LOGS || "",
  pkLogs: process.env.WEBHOOK_PK_LOGS || ""
};

function ensureDb() {
  const dataFolder = path.join(__dirname, "data");

  if (!fs.existsSync(dataFolder)) {
    fs.mkdirSync(dataFolder);
  }

  if (!fs.existsSync(DB_PATH)) {
    const starter = {
      codes: {},
      users: {},
      logs: [],
      nextIds: {
        Civilian: 132,
        Police: 232,
        EMS: 332,
        Staff: 432,
        "North Ave": 532,
        "Southline 47": 632,
        Eastgate: 732,
        Westbrook: 832,
        "River Park": 932,
        "Crown Heights": 982
      }
    };

    fs.writeFileSync(DB_PATH, JSON.stringify(starter, null, 2));
  }
}

function loadDb() {
  ensureDb();
  return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
}

function saveDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeCode(code) {
  return String(code || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

function cleanText(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  return String(value).trim().slice(0, 500);
}

function requireAdmin(req, res, next) {
  const key = req.headers["x-api-key"];

  if (key !== ADMIN_API_KEY) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized admin request."
    });
  }

  next();
}

function requireRoblox(req, res, next) {
  const key = req.headers["x-api-key"];

  if (key !== ROBLOX_API_KEY) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized Roblox request."
    });
  }

  next();
}

function generateRandomPart(length = 4) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";

  for (let i = 0; i < length; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }

  return out;
}

function rolePrefix(role, faction, department) {
  if (role === "Police" || department === "SPD") return "SL-SPD";
  if (role === "EMS" || department === "EMS") return "SL-EMS";
  if (role === "Staff") return "SL-STF";

  if (faction === "North Ave") return "SL-NA47";
  if (faction === "Southline 47") return "SL-S47";
  if (faction === "Eastgate") return "SL-EG";
  if (faction === "Westbrook") return "SL-WB";
  if (faction === "River Park") return "SL-RP";
  if (faction === "Crown Heights") return "SL-CH";

  return "SL-CIV";
}

function generateCode(role, faction, department) {
  const prefix = rolePrefix(role, faction, department);
  return `${prefix}-${generateRandomPart(4)}`;
}

function getIdBucket(role, faction, department) {
  if (role === "Police" || department === "SPD") return "Police";
  if (role === "EMS" || department === "EMS") return "EMS";
  if (role === "Staff") return "Staff";

  if (faction && faction !== "None") return faction;

  return "Civilian";
}

function assignPermanentId(db, role, faction, department) {
  const bucket = getIdBucket(role, faction, department);

  if (!db.nextIds[bucket]) {
    db.nextIds[bucket] = 1000;
  }

  const id = db.nextIds[bucket];
  db.nextIds[bucket] += 1;

  return id;
}

function addLog(db, type, data) {
  db.logs.push({
    id: crypto.randomUUID(),
    type,
    data,
    createdAt: nowIso()
  });

  if (db.logs.length > 1000) {
    db.logs = db.logs.slice(db.logs.length - 1000);
  }
}

async function sendWebhook(url, payload) {
  if (!url) return;

  try {
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    console.error("[Webhook Error]", err.message);
  }
}

async function sendDiscordLog(channel, title, description, color = 0x7aa7ff, fields = []) {
  const url = WEBHOOKS[channel];

  if (!url) return;

  await sendWebhook(url, {
    username: "Southline Control",
    embeds: [
      {
        title,
        description,
        color,
        fields,
        timestamp: nowIso(),
        footer: {
          text: "Southline County"
        }
      }
    ]
  });
}

function buildUserProfileFromCode(codeData, robloxUserId, robloxUsername) {
  return {
    robloxUserId: String(robloxUserId),
    robloxUsername: cleanText(robloxUsername),
    discord: codeData.discord || "Unknown",
    discordId: codeData.discordId || null,

    whitelisted: true,

    serverId: codeData.permanentId,
    role: codeData.role || "Civilian",
    faction: codeData.faction || "None",
    department: codeData.department || "None",

    permissions: {
      civilian: true,
      police: codeData.role === "Police" || codeData.department === "SPD",
      ems: codeData.role === "EMS" || codeData.department === "EMS",
      staff: codeData.role === "Staff",
      faction: codeData.faction && codeData.faction !== "None",
      factionLeader: codeData.factionLeader === true
    },

    activatedCode: codeData.code,
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
}

app.get("/", (req, res) => {
  res.json({
    success: true,
    name: "Southline Backend",
    status: "online",
    time: nowIso()
  });
});

app.get("/api/health", (req, res) => {
  const db = loadDb();

  res.json({
    success: true,
    status: "healthy",
    codes: Object.keys(db.codes).length,
    users: Object.keys(db.users).length,
    time: nowIso()
  });
});
app.post("/api/character/save", requireRoblox, async (req, res) => {
  const db = loadDb();

  const robloxUserId = cleanText(req.body.robloxUserId);
  const profile = db.users[String(robloxUserId)];

  if (!profile || !profile.whitelisted) {
    return res.status(403).json({
      success: false,
      error: "Player is not whitelisted."
    });
  }

  const appearance = req.body.appearance || {};

  const character = {
    firstName: cleanText(req.body.firstName, "Unknown"),
    lastName: cleanText(req.body.lastName, "Citizen"),
    age: cleanText(req.body.age, "18"),
    gender: cleanText(req.body.gender, "Unknown"),

    appearance: {
      skinName: cleanText(appearance.skinName, "Brown"),
      skinIndex: Number(appearance.skinIndex || 1),

      heightName: cleanText(appearance.heightName, "100%"),
      heightIndex: Number(appearance.heightIndex || 6),
      heightScale: Number(appearance.heightScale || 1),

      faceName: cleanText(appearance.faceName, "Default"),
      faceIndex: Number(appearance.faceIndex || 1),
      faceId: cleanText(appearance.faceId, ""),

      hairName: cleanText(appearance.hairName, "Default"),
      hairIndex: Number(appearance.hairIndex || 1),
      hairId: cleanText(appearance.hairId, ""),

      shirtName: cleanText(appearance.shirtName, "Default"),
      shirtIndex: Number(appearance.shirtIndex || 1),
      shirtId: cleanText(appearance.shirtId, ""),

      pantsName: cleanText(appearance.pantsName, "Default"),
      pantsIndex: Number(appearance.pantsIndex || 1),
      pantsId: cleanText(appearance.pantsId, "")
    },

    createdAt: profile.characterCreated ? profile.character?.createdAt || nowIso() : nowIso(),
    updatedAt: nowIso()
  };

  profile.characterCreated = true;
  profile.character = character;
  profile.updatedAt = nowIso();

  db.users[String(robloxUserId)] = profile;

  addLog(db, "CHARACTER_SAVED", {
    robloxUserId,
    robloxUsername: profile.robloxUsername,
    serverId: profile.serverId,
    character
  });

  saveDb(db);

  await sendDiscordLog(
    "whitelist",
    "Character Saved",
    `${character.firstName} ${character.lastName} has been created/updated.`,
    0x7aa7ff,
    [
      { name: "Roblox", value: profile.robloxUsername || "Unknown", inline: true },
      { name: "Server ID", value: String(profile.serverId), inline: true },
      { name: "Role", value: profile.role || "Civilian", inline: true },
      { name: "Faction", value: profile.faction || "None", inline: true },
      { name: "Shirt", value: character.appearance.shirtName || "Unknown", inline: true },
      { name: "Pants", value: character.appearance.pantsName || "Unknown", inline: true }
    ]
  );

  res.json({
    success: true,
    profile
  });
});

app.post("/api/character/pk", requireRoblox, async (req, res) => {
  const db = loadDb();

  const robloxUserId = cleanText(req.body.robloxUserId);
  const reason = cleanText(req.body.reason, "No reason provided.");
  const issuedBy = cleanText(req.body.issuedBy, "Unknown Staff");

  const profile = db.users[String(robloxUserId)];

  if (!profile || !profile.whitelisted) {
    return res.status(404).json({
      success: false,
      error: "Player profile not found."
    });
  }

  const oldCharacter = profile.character || null;

  profile.characterCreated = false;
  profile.character = null;
  profile.updatedAt = nowIso();

  db.users[String(robloxUserId)] = profile;

  addLog(db, "CHARACTER_PK", {
    robloxUserId,
    robloxUsername: profile.robloxUsername,
    serverId: profile.serverId,
    oldCharacter,
    reason,
    issuedBy
  });

  saveDb(db);

  await sendDiscordLog(
    "pkLogs",
    "Character PK Issued",
    `A character was permanently killed/reset.`,
    0xff5555,
    [
      { name: "Roblox", value: profile.robloxUsername || "Unknown", inline: true },
      { name: "Server ID", value: String(profile.serverId), inline: true },
      { name: "Reason", value: reason, inline: false },
      { name: "Issued By", value: issuedBy, inline: true }
    ]
  );

  res.json({
    success: true,
    profile
  });
});

app.post("/api/codes/create", requireAdmin, async (req, res) => {
  const db = loadDb();

  const robloxUsername = cleanText(req.body.robloxUsername);
  const discord = cleanText(req.body.discord);
  const discordId = cleanText(req.body.discordId, null);

  const role = cleanText(req.body.role, "Civilian");
  const faction = cleanText(req.body.faction, "None");
  const department = cleanText(req.body.department, "None");
  const issuedBy = cleanText(req.body.issuedBy, "Unknown Staff");

  const factionLeader = req.body.factionLeader === true;

  let permanentId = req.body.permanentId ? Number(req.body.permanentId) : null;

  if (!permanentId) {
    permanentId = assignPermanentId(db, role, faction, department);
  }

  let code = normalizeCode(req.body.code);

  if (!code) {
    do {
      code = generateCode(role, faction, department);
    } while (db.codes[code]);
  }

  if (db.codes[code]) {
    return res.status(400).json({
      success: false,
      error: "Code already exists."
    });
  }

  const codeData = {
    code,
    robloxUsername,
    discord,
    discordId,
    role,
    faction,
    department,
    permanentId,
    factionLeader,
    status: "Unused",
    used: false,
    usedByRobloxUserId: null,
    usedByRobloxUsername: null,
    issuedBy,
    issuedAt: nowIso(),
    activatedAt: null,
    voidedAt: null,
    voidReason: null
  };

  db.codes[code] = codeData;

  addLog(db, "CODE_CREATED", {
    code,
    robloxUsername,
    discord,
    role,
    faction,
    department,
    permanentId,
    issuedBy
  });

  saveDb(db);

  await sendDiscordLog(
    "whitelist",
    "Access Code Created",
    `A new Southline access code was created.`,
    0x62d98f,
    [
      { name: "Code", value: code, inline: true },
      { name: "Roblox", value: robloxUsername || "Unknown", inline: true },
      { name: "Discord", value: discord || "Unknown", inline: true },
      { name: "Role", value: role, inline: true },
      { name: "Faction", value: faction, inline: true },
      { name: "Department", value: department, inline: true },
      { name: "Permanent ID", value: String(permanentId), inline: true },
      { name: "Issued By", value: issuedBy, inline: true }
    ]
  );

  res.json({
    success: true,
    code: codeData
  });
});

app.get("/api/codes", requireAdmin, (req, res) => {
  const db = loadDb();

  const codes = Object.values(db.codes).sort((a, b) => {
    return String(b.issuedAt).localeCompare(String(a.issuedAt));
  });

  res.json({
    success: true,
    count: codes.length,
    codes
  });
});

app.post("/api/codes/void", requireAdmin, async (req, res) => {
  const db = loadDb();

  const code = normalizeCode(req.body.code);
  const reason = cleanText(req.body.reason, "No reason provided.");
  const voidedBy = cleanText(req.body.voidedBy, "Unknown Staff");

  const codeData = db.codes[code];

  if (!codeData) {
    return res.status(404).json({
      success: false,
      error: "Code not found."
    });
  }

  codeData.status = "Void";
  codeData.used = true;
  codeData.voidedAt = nowIso();
  codeData.voidReason = reason;

  addLog(db, "CODE_VOIDED", {
    code,
    reason,
    voidedBy
  });

  saveDb(db);

  await sendDiscordLog(
    "staffLogs",
    "Access Code Voided",
    `A Southline access code was voided.`,
    0xff5555,
    [
      { name: "Code", value: code, inline: true },
      { name: "Reason", value: reason, inline: false },
      { name: "Voided By", value: voidedBy, inline: true }
    ]
  );

  res.json({
    success: true,
    code: codeData
  });
});

app.post("/api/verify-code", requireRoblox, async (req, res) => {
  const db = loadDb();

  const code = normalizeCode(req.body.code);
  const robloxUserId = cleanText(req.body.robloxUserId);
  const robloxUsername = cleanText(req.body.robloxUsername);

  if (!code || !robloxUserId) {
    return res.status(400).json({
      success: false,
      error: "Missing code or Roblox user ID."
    });
  }

  const existingUser = db.users[String(robloxUserId)];

  if (existingUser && existingUser.whitelisted) {
    return res.json({
      success: true,
      alreadyVerified: true,
      profile: existingUser
    });
  }

  const codeData = db.codes[code];

  if (!codeData) {
    return res.status(404).json({
      success: false,
      error: "Invalid access code."
    });
  }

  if (codeData.used || codeData.status !== "Unused") {
    return res.status(403).json({
      success: false,
      error: "This access code has already been used or voided."
    });
  }

  if (
    codeData.robloxUsername &&
    robloxUsername &&
    codeData.robloxUsername.toLowerCase() !== robloxUsername.toLowerCase()
  ) {
    return res.status(403).json({
      success: false,
      error: "This access code is not assigned to this Roblox username."
    });
  }

  const profile = buildUserProfileFromCode(codeData, robloxUserId, robloxUsername);

  db.users[String(robloxUserId)] = profile;

  codeData.used = true;
  codeData.status = "Used";
  codeData.usedByRobloxUserId = String(robloxUserId);
  codeData.usedByRobloxUsername = robloxUsername;
  codeData.activatedAt = nowIso();

  addLog(db, "CODE_USED", {
    code,
    robloxUserId,
    robloxUsername,
    serverId: profile.serverId,
    role: profile.role,
    faction: profile.faction,
    department: profile.department
  });

  saveDb(db);

  await sendDiscordLog(
    "whitelist",
    "Access Code Activated",
    `A player activated their Southline access code.`,
    0x7aa7ff,
    [
      { name: "Code", value: code, inline: true },
      { name: "Roblox", value: robloxUsername || "Unknown", inline: true },
      { name: "User ID", value: String(robloxUserId), inline: true },
      { name: "Server ID", value: String(profile.serverId), inline: true },
      { name: "Role", value: profile.role, inline: true },
      { name: "Faction", value: profile.faction, inline: true },
      { name: "Department", value: profile.department, inline: true }
    ]
  );

  res.json({
    success: true,
    alreadyVerified: false,
    profile
  });
});

app.get("/api/player/:robloxUserId", requireRoblox, (req, res) => {
  const db = loadDb();

  const robloxUserId = String(req.params.robloxUserId);
  const profile = db.users[robloxUserId];

  if (!profile) {
    return res.status(404).json({
      success: false,
      error: "Player is not whitelisted."
    });
  }

  res.json({
    success: true,
    profile
  });
});

app.post("/api/report", requireRoblox, async (req, res) => {
  const db = loadDb();

  const report = {
    robloxUserId: cleanText(req.body.robloxUserId),
    robloxUsername: cleanText(req.body.robloxUsername),
    serverId: cleanText(req.body.serverId, "Unknown"),
    characterName: cleanText(req.body.characterName, "Unknown"),
    location: cleanText(req.body.location, "Unknown"),
    message: cleanText(req.body.message, "No message provided."),
    createdAt: nowIso()
  };

  addLog(db, "PLAYER_REPORT", report);
  saveDb(db);

  await sendDiscordLog(
    "reports",
    "Player Report",
    report.message,
    0xffb84d,
    [
      { name: "Player", value: `${report.characterName} [${report.serverId}]`, inline: true },
      { name: "Roblox", value: report.robloxUsername || "Unknown", inline: true },
      { name: "Location", value: report.location || "Unknown", inline: true }
    ]
  );

  res.json({
    success: true,
    message: "Report submitted."
  });
});

app.post("/api/changelog", requireAdmin, async (req, res) => {
  const db = loadDb();

  const title = cleanText(req.body.title, "Southline Development Update");
  const message = cleanText(req.body.message, "No update provided.");
  const postedBy = cleanText(req.body.postedBy, "Unknown Staff");

  const log = {
    title,
    message,
    postedBy,
    createdAt: nowIso()
  };

  addLog(db, "CHANGELOG", log);
  saveDb(db);

  await sendDiscordLog(
    "changelogs",
    title,
    message,
    0x9b7aff,
    [
      { name: "Posted By", value: postedBy, inline: true }
    ]
  );

  res.json({
    success: true,
    log
  });
});

app.post("/api/announcement", requireAdmin, async (req, res) => {
  const db = loadDb();

  const title = cleanText(req.body.title, "Southline Announcement");
  const message = cleanText(req.body.message, "No announcement provided.");
  const postedBy = cleanText(req.body.postedBy, "Unknown Staff");

  const log = {
    title,
    message,
    postedBy,
    createdAt: nowIso()
  };

  addLog(db, "ANNOUNCEMENT", log);
  saveDb(db);

  await sendDiscordLog(
    "announcements",
    title,
    message,
    0xf1c65b,
    [
      { name: "Posted By", value: postedBy, inline: true }
    ]
  );

  res.json({
    success: true,
    log
  });
});

app.post("/api/staff-log", requireRoblox, async (req, res) => {
  const db = loadDb();

  const log = {
    action: cleanText(req.body.action, "Unknown action"),
    staffRobloxUsername: cleanText(req.body.staffRobloxUsername, "Unknown"),
    staffServerId: cleanText(req.body.staffServerId, "Unknown"),
    targetRobloxUsername: cleanText(req.body.targetRobloxUsername, "None"),
    targetServerId: cleanText(req.body.targetServerId, "None"),
    reason: cleanText(req.body.reason, "No reason provided."),
    createdAt: nowIso()
  };

  addLog(db, "STAFF_ACTION", log);
  saveDb(db);

  await sendDiscordLog(
    "staffLogs",
    "Staff Action",
    log.action,
    0xff5555,
    [
      { name: "Staff", value: `${log.staffRobloxUsername} [${log.staffServerId}]`, inline: true },
      { name: "Target", value: `${log.targetRobloxUsername} [${log.targetServerId}]`, inline: true },
      { name: "Reason", value: log.reason, inline: false }
    ]
  );

  res.json({
    success: true,
    log
  });
});

app.post("/api/faction-log", requireRoblox, async (req, res) => {
  const db = loadDb();

  const log = {
    faction: cleanText(req.body.faction, "Unknown"),
    action: cleanText(req.body.action, "Unknown action"),
    robloxUsername: cleanText(req.body.robloxUsername, "Unknown"),
    serverId: cleanText(req.body.serverId, "Unknown"),
    details: cleanText(req.body.details, "No details."),
    createdAt: nowIso()
  };

  addLog(db, "FACTION_ACTION", log);
  saveDb(db);

  await sendDiscordLog(
    "factionLogs",
    "Faction Log",
    `${log.faction}: ${log.action}`,
    0x8f7aff,
    [
      { name: "Player", value: `${log.robloxUsername} [${log.serverId}]`, inline: true },
      { name: "Details", value: log.details, inline: false }
    ]
  );

  res.json({
    success: true,
    log
  });
});

app.post("/api/inventory-log", requireRoblox, async (req, res) => {
  const db = loadDb();

  const log = {
    action: cleanText(req.body.action, "Unknown action"),
    robloxUsername: cleanText(req.body.robloxUsername, "Unknown"),
    serverId: cleanText(req.body.serverId, "Unknown"),
    item: cleanText(req.body.item, "Unknown item"),
    amount: cleanText(req.body.amount, "Unknown"),
    details: cleanText(req.body.details, "No details."),
    createdAt: nowIso()
  };

  addLog(db, "INVENTORY_ACTION", log);
  saveDb(db);

  await sendDiscordLog(
    "inventoryLogs",
    "Inventory Log",
    log.action,
    0x5bd69c,
    [
      { name: "Player", value: `${log.robloxUsername} [${log.serverId}]`, inline: true },
      { name: "Item", value: `${log.item} x${log.amount}`, inline: true },
      { name: "Details", value: log.details, inline: false }
    ]
  );

  res.json({
    success: true,
    log
  });
});

app.get("/api/logs", requireAdmin, (req, res) => {
  const db = loadDb();

  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const logs = db.logs.slice(-limit).reverse();

  res.json({
    success: true,
    count: logs.length,
    logs
  });
});

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Route not found."
  });
});

app.listen(PORT, () => {
  console.log("====================================");
  console.log("Southline Backend online");
  console.log(`Port: ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/api/health`);
  console.log("====================================");
});