-- Sales quiz tool: two bilingual assessments (Real Estate Market, Whispyr System).
-- D1 (binding `DB`), alongside the existing `users` table. Timestamps are unix ms
-- INTEGER like 0001. Apply with:
--   npx wrangler d1 migrations apply sales_portal_users [--remote]

CREATE TABLE IF NOT EXISTS quizzes (
  id             TEXT PRIMARY KEY,
  key            TEXT NOT NULL UNIQUE,           -- 'real-estate-market' | 'whispyr-system'
  title_en       TEXT NOT NULL,
  title_ar       TEXT NOT NULL,
  description_en TEXT NOT NULL DEFAULT '',
  description_ar TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'draft',  -- 'draft' | 'open' | 'closed'
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS quiz_questions (
  id             TEXT PRIMARY KEY,
  quiz_id        TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  position       INTEGER NOT NULL,               -- 1-based order within the quiz
  type           TEXT NOT NULL,                  -- 'single' | 'multi' | 'short'
  points         INTEGER NOT NULL,               -- 1 for single/multi, 3 for short
  title_en       TEXT NOT NULL DEFAULT '',
  title_ar       TEXT NOT NULL DEFAULT '',
  prompt_en      TEXT NOT NULL,
  prompt_ar      TEXT NOT NULL,
  options_json   TEXT,                           -- JSON [{id,en,ar}]; NULL for short
  correct_json   TEXT,                           -- JSON ["b"] / ["a","c","e"]; NULL for short
  explanation_en TEXT NOT NULL DEFAULT '',       -- the "Why" (MCQ); shown only in review
  explanation_ar TEXT NOT NULL DEFAULT '',
  rubric_en      TEXT NOT NULL DEFAULT '',       -- short-answer scoring rubric
  rubric_ar      TEXT NOT NULL DEFAULT '',
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quiz_questions_quiz ON quiz_questions (quiz_id, position);

CREATE TABLE IF NOT EXISTS quiz_attempts (
  id           TEXT PRIMARY KEY,
  quiz_id      TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'in_progress', -- 'in_progress' | 'submitted' | 'graded'
  started_at   INTEGER,
  submitted_at INTEGER,
  mcq_score    INTEGER,                          -- auto, set on submit
  mcq_max      INTEGER,                          -- sum of MCQ points at submit time
  short_score  INTEGER,                          -- set on grade finalize
  short_max    INTEGER,                          -- sum of short points at submit time
  total_score  INTEGER,                          -- mcq_score + short_score, set on finalize
  total_max    INTEGER,                          -- mcq_max + short_max
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE (quiz_id, user_id)                       -- one attempt per rep per quiz
);

CREATE TABLE IF NOT EXISTS quiz_answers (
  id             TEXT PRIMARY KEY,
  attempt_id     TEXT NOT NULL REFERENCES quiz_attempts(id) ON DELETE CASCADE,
  question_id    TEXT NOT NULL REFERENCES quiz_questions(id) ON DELETE CASCADE,
  selected_json  TEXT,                           -- JSON array of chosen option ids (MCQ)
  text_answer    TEXT,                           -- free text (short)
  awarded_points INTEGER,                        -- MCQ: auto; short: admin-set, NULL until graded
  is_correct     INTEGER,                        -- 0/1 (MCQ convenience)
  grader_note    TEXT,                           -- admin note on a short answer, shown to rep after grading
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  UNIQUE (attempt_id, question_id)
);
