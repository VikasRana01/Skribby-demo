// src/db/migrate.js  —  node src/db/migrate.js
const pool = require('./index');

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('🔄 Running migrations...');

    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id            SERIAL PRIMARY KEY,
        email         VARCHAR(255) UNIQUE NOT NULL,
        name          VARCHAR(255) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at    TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS zoom_tokens (
        id            SERIAL PRIMARY KEY,
        user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
        zoom_user_id  VARCHAR(255),
        access_token  TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expires_at    TIMESTAMP NOT NULL,
        scope         TEXT,
        created_at    TIMESTAMP DEFAULT NOW(),
        updated_at    TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS google_tokens (
        user_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        google_user_id VARCHAR(255),
        email         VARCHAR(255),
        access_token  TEXT NOT NULL,
        refresh_token TEXT,
        expires_at    TIMESTAMP NOT NULL,
        scope         TEXT,
        created_at    TIMESTAMP DEFAULT NOW(),
        updated_at    TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS microsoft_tokens (
        user_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        ms_user_id    VARCHAR(255),
        email         VARCHAR(255),
        access_token  TEXT NOT NULL,
        refresh_token TEXT,
        expires_at    TIMESTAMP NOT NULL,
        scope         TEXT,
        created_at    TIMESTAMP DEFAULT NOW(),
        updated_at    TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS bot_sessions (
        id              SERIAL PRIMARY KEY,
        user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
        bot_id          VARCHAR(255) UNIQUE NOT NULL,
        meeting_url     TEXT NOT NULL,
        meeting_title   VARCHAR(500) DEFAULT 'Zoom Meeting',
        bot_name        VARCHAR(255) DEFAULT 'AI Notetaker',
        status          VARCHAR(50)  DEFAULT 'created',
        provider_status VARCHAR(100),
        transcript      TEXT,
        joined_at       TIMESTAMP,
        left_at         TIMESTAMP,
        created_at      TIMESTAMP DEFAULT NOW(),
        updated_at      TIMESTAMP DEFAULT NOW()
      );
    `);

    // Existing DBs (e.g. older SkribbyDemo or Recall-style schema) may lack provider_status
    await client.query(`
      ALTER TABLE bot_sessions
      ADD COLUMN IF NOT EXISTS provider_status VARCHAR(100);
    `);
    await client.query(`
      ALTER TABLE bot_sessions
      ADD COLUMN IF NOT EXISTS scheduled_join_at TIMESTAMP;
    `);
    await client.query(`
      ALTER TABLE bot_sessions
      ADD COLUMN IF NOT EXISTS media_archive_filename VARCHAR(512);
    `);
    await client.query(`
      DO $blk$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'bot_sessions' AND column_name = 'recall_status'
        ) THEN
          UPDATE bot_sessions SET provider_status = recall_status
          WHERE provider_status IS NULL AND recall_status IS NOT NULL;
        END IF;
      END
      $blk$;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS synced_calendar_meetings (
        id               SERIAL PRIMARY KEY,
        user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        source           VARCHAR(32) NOT NULL,
        external_id      VARCHAR(512) NOT NULL,
        title            VARCHAR(500),
        start_at         TIMESTAMPTZ NOT NULL,
        end_at           TIMESTAMPTZ,
        join_url         TEXT NOT NULL,
        platform         VARCHAR(32),
        skribby_bot_id   VARCHAR(255),
        schedule_error   TEXT,
        last_synced_at   TIMESTAMPTZ NOT NULL,
        created_at       TIMESTAMP DEFAULT NOW(),
        updated_at       TIMESTAMP DEFAULT NOW(),
        UNIQUE (user_id, source, external_id)
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_synced_cal_user ON synced_calendar_meetings (user_id);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS summaries (
        id            SERIAL PRIMARY KEY,
        user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
        bot_session_id INTEGER REFERENCES bot_sessions(id) ON DELETE CASCADE,
        meeting_title VARCHAR(500),
        transcript    TEXT,
        summary       TEXT,
        key_points    JSONB DEFAULT '[]',
        action_items  JSONB DEFAULT '[]',
        decisions     JSONB DEFAULT '[]',
        next_steps    TEXT,
        status        VARCHAR(50) DEFAULT 'processing',
        error_message TEXT,
        created_at    TIMESTAMP DEFAULT NOW(),
        updated_at    TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query(`
      ALTER TABLE summaries
      ADD COLUMN IF NOT EXISTS headline VARCHAR(500);
    `);

    console.log('✅ All tables created successfully!');
  } catch (err) {
    console.error('❌ Migration error:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
