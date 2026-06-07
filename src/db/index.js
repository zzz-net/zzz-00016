const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', '..', 'data', 'school-bus.db');

let db;

function getDb() {
  if (!db) {
    const fs = require('fs');
    const dbDir = path.dirname(DB_PATH);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

function initDb() {
  const d = getDb();
  d.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('teacher','dispatcher','safety','admin')),
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      applicant_id INTEGER NOT NULL,
      route_name TEXT NOT NULL,
      original_stops TEXT NOT NULL,
      new_stops TEXT NOT NULL,
      effective_start TEXT NOT NULL,
      effective_end TEXT NOT NULL,
      vehicle_id TEXT,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING_SUBMITTED' CHECK(status IN (
        'PENDING_SUBMITTED','DISPATCH_REVIEWED','SAFETY_APPROVED',
        'PUBLISHED','REJECTED','CANCELLED'
      )),
      reject_reason TEXT,
      source_application_id INTEGER,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (applicant_id) REFERENCES users(id),
      FOREIGN KEY (source_application_id) REFERENCES applications(id)
    );

    CREATE TABLE IF NOT EXISTS approval_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id INTEGER NOT NULL,
      operator_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      comment TEXT,
      from_status TEXT,
      to_status TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (application_id) REFERENCES applications(id),
      FOREIGN KEY (operator_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      action TEXT NOT NULL,
      resource TEXT,
      resource_id INTEGER,
      detail TEXT,
      ip TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS conflicts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id INTEGER NOT NULL,
      conflict_type TEXT NOT NULL CHECK(conflict_type IN ('TIME','VEHICLE','BOTH','STOP')),
      conflict_detail TEXT NOT NULL,
      conflicting_application_id INTEGER,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (application_id) REFERENCES applications(id)
    );

    CREATE TABLE IF NOT EXISTS risk_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_type TEXT NOT NULL CHECK(rule_type IN ('BANNED_STOP','BANNED_TIME_WINDOW','VEHICLE_RESTRICTION','KEYWORD')),
      name TEXT NOT NULL,
      description TEXT,
      rule_config TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','INACTIVE')),
      hit_count INTEGER NOT NULL DEFAULT 0,
      last_hit_at TEXT,
      created_by INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS risk_rule_hits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id INTEGER NOT NULL,
      application_id INTEGER,
      hit_detail TEXT NOT NULL,
      created_by INTEGER,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (rule_id) REFERENCES risk_rules(id),
      FOREIGN KEY (application_id) REFERENCES applications(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS announcements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id INTEGER NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      route_name TEXT NOT NULL,
      affected_stops TEXT NOT NULL,
      effective_start TEXT NOT NULL,
      effective_end TEXT NOT NULL,
      remark TEXT,
      created_by INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(application_id, version),
      FOREIGN KEY (application_id) REFERENCES applications(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_conflicts_app ON conflicts(application_id);
    CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status);
    CREATE INDEX IF NOT EXISTS idx_applications_route ON applications(route_name);
    CREATE INDEX IF NOT EXISTS idx_applications_time ON applications(effective_start, effective_end);
    CREATE INDEX IF NOT EXISTS idx_approval_logs_app ON approval_logs(application_id);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id);
    CREATE INDEX IF NOT EXISTS idx_applications_source ON applications(source_application_id);
    CREATE INDEX IF NOT EXISTS idx_risk_rules_status ON risk_rules(status);
    CREATE INDEX IF NOT EXISTS idx_risk_rules_type ON risk_rules(rule_type);
    CREATE INDEX IF NOT EXISTS idx_risk_rule_hits_rule ON risk_rule_hits(rule_id);
    CREATE INDEX IF NOT EXISTS idx_risk_rule_hits_app ON risk_rule_hits(application_id);
    CREATE INDEX IF NOT EXISTS idx_announcements_app ON announcements(application_id);
    CREATE INDEX IF NOT EXISTS idx_announcements_route ON announcements(route_name);
    CREATE INDEX IF NOT EXISTS idx_announcements_created ON announcements(created_at);
  `);

  const migrationRow = d.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='conflicts'").get();
  if (migrationRow && migrationRow.sql && !migrationRow.sql.includes("'STOP'")) {
    d.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE IF NOT EXISTS conflicts_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        application_id INTEGER NOT NULL,
        conflict_type TEXT NOT NULL CHECK(conflict_type IN ('TIME','VEHICLE','BOTH','STOP')),
        conflict_detail TEXT NOT NULL,
        conflicting_application_id INTEGER,
        created_at TEXT DEFAULT (datetime('now','localtime')),
        FOREIGN KEY (application_id) REFERENCES applications(id)
      );
      INSERT INTO conflicts_new (id, application_id, conflict_type, conflict_detail, conflicting_application_id, created_at)
      SELECT id, application_id, conflict_type, conflict_detail, conflicting_application_id, created_at FROM conflicts;
      DROP TABLE conflicts;
      ALTER TABLE conflicts_new RENAME TO conflicts;
      PRAGMA foreign_keys = ON;
    `);
  }

  const appCols = d.prepare("PRAGMA table_info(applications)").all();
  if (!appCols.find(c => c.name === 'cancel_remark')) {
    d.exec(`ALTER TABLE applications ADD COLUMN cancel_remark TEXT`);
  }
  if (!appCols.find(c => c.name === 'source_application_id')) {
    d.exec(`ALTER TABLE applications ADD COLUMN source_application_id INTEGER REFERENCES applications(id)`);
  }

  const sourceIdx = d.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_applications_source'").get();
  if (!sourceIdx) {
    d.exec(`CREATE INDEX IF NOT EXISTS idx_applications_source ON applications(source_application_id)`);
  }

  const riskRulesTable = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='risk_rules'").get();
  if (!riskRulesTable) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS risk_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_type TEXT NOT NULL CHECK(rule_type IN ('BANNED_STOP','BANNED_TIME_WINDOW','VEHICLE_RESTRICTION','KEYWORD')),
        name TEXT NOT NULL,
        description TEXT,
        rule_config TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','INACTIVE')),
        hit_count INTEGER NOT NULL DEFAULT 0,
        last_hit_at TEXT,
        created_by INTEGER NOT NULL,
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime')),
        FOREIGN KEY (created_by) REFERENCES users(id)
      );
      CREATE INDEX IF NOT EXISTS idx_risk_rules_status ON risk_rules(status);
      CREATE INDEX IF NOT EXISTS idx_risk_rules_type ON risk_rules(rule_type);
    `);
  }

  const riskRuleHitsTable = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='risk_rule_hits'").get();
  if (!riskRuleHitsTable) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS risk_rule_hits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_id INTEGER NOT NULL,
        application_id INTEGER,
        hit_detail TEXT NOT NULL,
        created_by INTEGER,
        created_at TEXT DEFAULT (datetime('now','localtime')),
        FOREIGN KEY (rule_id) REFERENCES risk_rules(id),
        FOREIGN KEY (application_id) REFERENCES applications(id),
        FOREIGN KEY (created_by) REFERENCES users(id)
      );
      CREATE INDEX IF NOT EXISTS idx_risk_rule_hits_rule ON risk_rule_hits(rule_id);
      CREATE INDEX IF NOT EXISTS idx_risk_rule_hits_app ON risk_rule_hits(application_id);
    `);
  }

  const riskCols = d.prepare("PRAGMA table_info(risk_rules)").all();
  if (!riskCols.find(c => c.name === 'hit_count')) {
    d.exec(`ALTER TABLE risk_rules ADD COLUMN hit_count INTEGER NOT NULL DEFAULT 0`);
  }
  if (!riskCols.find(c => c.name === 'last_hit_at')) {
    d.exec(`ALTER TABLE risk_rules ADD COLUMN last_hit_at TEXT`);
  }

  const announcementsTable = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='announcements'").get();
  if (!announcementsTable) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS announcements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        application_id INTEGER NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        route_name TEXT NOT NULL,
        affected_stops TEXT NOT NULL,
        effective_start TEXT NOT NULL,
        effective_end TEXT NOT NULL,
        remark TEXT,
        created_by INTEGER NOT NULL,
        created_at TEXT DEFAULT (datetime('now','localtime')),
        UNIQUE(application_id, version),
        FOREIGN KEY (application_id) REFERENCES applications(id),
        FOREIGN KEY (created_by) REFERENCES users(id)
      );
      CREATE INDEX IF NOT EXISTS idx_announcements_app ON announcements(application_id);
      CREATE INDEX IF NOT EXISTS idx_announcements_route ON announcements(route_name);
      CREATE INDEX IF NOT EXISTS idx_announcements_created ON announcements(created_at);
    `);
  }

  return d;
}

module.exports = { getDb, initDb, DB_PATH };
