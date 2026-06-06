/**
 * Appwrite Cloud Function: compute-analytics
 *
 * Aggregates visit_answers per project+phase and writes a compact summary
 * document to analytics_summaries.  The dashboard reads only those 2 docs
 * (baseline + endline) instead of fetching the full visit_answers table.
 *
 * Schedule: run nightly (e.g. "0 2 * * *" in Appwrite Function settings).
 *
 * Required env vars (set in Appwrite Function → Settings → Variables):
 *   APPWRITE_DATABASE_ID
 *   VISITS_COL_ID           (default: "visits")
 *   VISIT_ANSWERS_COL_ID    (default: "visit_answers")
 *   ANALYTICS_COL_ID        (default: "analytics")
 *   ANALYTICS_SUMMARIES_COL_ID  (default: "analytics_summaries")
 *   PROJECTS_COL_ID         (default: "projects")
 *   QUESTIONS_COL_ID        (default: "questions")
 *
 * Appwrite automatically injects:
 *   APPWRITE_FUNCTION_API_ENDPOINT
 *   APPWRITE_FUNCTION_PROJECT_ID
 *   APPWRITE_API_KEY
 */

import { Client, Databases, Query } from "node-appwrite";

// ── Env config ────────────────────────────────────────────────────────────────

const DB_ID = process.env.APPWRITE_DATABASE_ID;
const VISITS_COL = process.env.VISITS_COL_ID || "visits";
const ANSWERS_COL = process.env.VISIT_ANSWERS_COL_ID || "visit_answers";
const ANALYTICS_COL = process.env.ANALYTICS_COL_ID || "analytics";
const SUMMARIES_COL =
  process.env.ANALYTICS_SUMMARIES_COL_ID || "analytics_summaries";
const PROJECTS_COL = process.env.PROJECTS_COL_ID || "projects";
const QUESTIONS_COL = process.env.QUESTIONS_COL_ID || "questions";

const PHASES = ["baseline", "endline"];
const PAGE = 1000; // server-side SDK supports up to 5000, 1000 is safe

// ── Text utilities ────────────────────────────────────────────────────────────

function normalizeText(value) {
  if (value == null) return "";
  return String(value)
    .normalize("NFKC")
    .replace(/[ ​]/g, " ")
    .replace(/[–—]/g, "-")
    .replace(/["""'`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Split a raw answer that may be a JSON array (multi-select) or a plain string.
 * Returns individual string values.
 */
function splitAnswerValues(raw) {
  if (raw == null) return [];
  const str = String(raw).trim();
  if (!str) return [];

  if (str.startsWith("[")) {
    try {
      const parsed = JSON.parse(str);
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch {
      // fall through
    }
  }

  return str
    .split(/\s*\|\s*|\s*,\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Return the first non-null answer value from a visit_answer document. */
function getAnswerValue(doc) {
  if (doc.answer_number != null) return String(doc.answer_number);
  if (doc.answer_decimal != null) return String(doc.answer_decimal);
  if (doc.answer_text != null && doc.answer_text !== "") return doc.answer_text;
  if (doc.answer_date != null) return doc.answer_date;
  return null;
}

// ── Annual workday band helpers (mirrors dashboard logic) ─────────────────────

function workMonthsMidpoint(v) {
  const n = normalizeText(v);
  // matches both canonical English and opt-value forms
  if (n === "opt1" || n.includes("0-3") || n.includes("0 - 3")) return 1.5;
  if (n === "opt2" || n.includes("4-6") || n.includes("4 - 6")) return 5;
  if (n === "opt3" || n.includes("7-9") || n.includes("7 - 9")) return 8;
  if (n === "opt4" || n.includes("10-12") || n.includes("10 - 12")) return 11;
  return null;
}

function workDaysMidpoint(v) {
  const n = normalizeText(v);
  if (n === "opt1" || n.includes("1-5") || n.includes("1 - 5")) return 3;
  if (n === "opt2" || n.includes("6-10") || n.includes("6 - 10")) return 8;
  if (n === "opt3" || n.includes("11-20") || n.includes("11 - 20")) return 15.5;
  if (n === "opt4" || n.includes("more than 20") || n.includes("20 ದಿನ"))
    return 24;
  return null;
}

function annualWorkdayBand(months, days) {
  if (months == null || days == null) return null;
  const annual = months * days;
  if (annual <= 0) return "0 Days";
  if (annual < 100) return "1-100 Days";
  if (annual < 180) return "100-180 Days";
  if (annual < 240) return "180-240 Days";
  return ">240 Days";
}

// ── Appwrite fetch helpers ────────────────────────────────────────────────────

async function listAll(db, collectionId, queries) {
  const docs = [];
  let offset = 0;
  while (true) {
    const res = await db.listDocuments(DB_ID, collectionId, [
      ...queries,
      Query.limit(PAGE),
      Query.offset(offset),
    ]);
    docs.push(...res.documents);
    if (res.documents.length < PAGE) break;
    offset += PAGE;
  }
  return docs;
}

/** Build a Map<questionId, questionKey> from the questions collection. */
async function loadQuestionKeyMap(db) {
  const questions = await listAll(db, QUESTIONS_COL, []);
  const map = new Map();
  questions.forEach((q) => {
    if (q.$id && q.question_key) map.set(q.$id, q.question_key);
  });
  return map;
}

// ── Core aggregation ──────────────────────────────────────────────────────────

/**
 * Resolve the question_key for an answer document.
 * Handles both embedded relationship objects and plain string IDs.
 */
function resolveQuestionKey(answer, questionKeyMap) {
  if (answer.question && typeof answer.question === "object") {
    if (answer.question.question_key) return answer.question.question_key;
    if (answer.question.$id)
      return questionKeyMap.get(answer.question.$id) || null;
  }
  if (typeof answer.question === "string") {
    return questionKeyMap.get(answer.question) || null;
  }
  return null;
}

function resolveVisitId(answer) {
  if (answer.visit && typeof answer.visit === "object")
    return answer.visit.$id || null;
  if (typeof answer.visit === "string") return answer.visit;
  return null;
}

/**
 * Aggregate all visit_answers for the given visit IDs.
 *
 * Returns:
 *   questionData: {
 *     [questionKey]: { _total_visits: N, answers: { [normalizedRawValue]: count } }
 *     _computed_annual_workdays: { _total_visits: N, answers: { [band]: count } }
 *   }
 */
async function aggregatePhase(db, visitIds, questionKeyMap, log) {
  // questionKey → { visits: Set<visitId>, answers: { normalized: count } }
  const qMap = {};

  // For cross-tabulated annual workday chart
  const q12ByVisit = {};
  const q13ByVisit = {};

  const BATCH = 100; // batch visit IDs per query
  for (let i = 0; i < visitIds.length; i += BATCH) {
    const batch = visitIds.slice(i, i + BATCH);
    const answers = await listAll(db, ANSWERS_COL, [
      Query.equal("visit", batch),
    ]);

    for (const answer of answers) {
      const qKey = resolveQuestionKey(answer, questionKeyMap);
      if (!qKey) continue;

      const rawValue = getAnswerValue(answer);
      if (rawValue == null) continue;

      const visitId = resolveVisitId(answer);
      if (!visitId) continue;

      // Track work-schedule questions for the computed chart
      if (qKey === "q12_work_months_year") q12ByVisit[visitId] = rawValue;
      if (qKey === "q13_work_days_month") q13ByVisit[visitId] = rawValue;

      if (!qMap[qKey]) qMap[qKey] = { visits: new Set(), answers: {} };

      // Multi-select: split, normalize, and count each value separately
      for (const v of splitAnswerValues(rawValue)) {
        const key = normalizeText(v);
        if (!key) continue;
        qMap[qKey].answers[key] = (qMap[qKey].answers[key] || 0) + 1;
      }
      qMap[qKey].visits.add(visitId);
    }

    if ((i / BATCH) % 10 === 0)
      log(`    processed ${i + batch.length}/${visitIds.length} visits`);
  }

  // Convert Sets to counts
  const questionData = {};
  for (const [key, data] of Object.entries(qMap)) {
    questionData[key] = {
      _total_visits: data.visits.size,
      answers: data.answers,
    };
  }

  // Compute annual workday bands (requires per-visit cross-tabulation)
  const annualBands = {};
  let annualTotal = 0;
  const allWorkVisits = new Set([
    ...Object.keys(q12ByVisit),
    ...Object.keys(q13ByVisit),
  ]);

  for (const visitId of allWorkVisits) {
    const months = workMonthsMidpoint(q12ByVisit[visitId] || "");
    const days = workDaysMidpoint(q13ByVisit[visitId] || "");
    const band = annualWorkdayBand(months, days);
    if (!band) continue;
    annualBands[band] = (annualBands[band] || 0) + 1;
    annualTotal++;
  }

  questionData["_computed_annual_workdays"] = {
    _total_visits: annualTotal,
    answers: annualBands,
  };

  return questionData;
}

/**
 * Count nutrition labels from the analytics collection for one project+phase.
 * Returns { _total: N, labels: { [LABEL]: count } }
 */
async function aggregateNutrition(db, projectId, phase) {
  const rows = await listAll(db, ANALYTICS_COL, [
    Query.equal("project", projectId),
    Query.equal("phase", phase),
  ]);

  const labels = {};
  for (const row of rows) {
    let arr = row.nutrition_labels;
    if (!arr) continue;
    if (typeof arr === "string") {
      if (arr.startsWith("[")) {
        try {
          arr = JSON.parse(arr);
        } catch {
          arr = [];
        }
      } else {
        arr = arr.split(/[,|]/).map((l) => l.trim());
      }
    }
    if (!Array.isArray(arr)) continue;
    for (const label of arr) {
      const key = String(label).toUpperCase().trim();
      if (key) labels[key] = (labels[key] || 0) + 1;
    }
  }

  return { _total: rows.length, labels };
}

/** Upsert one analytics_summaries document for (project, phase). */
async function upsertSummary(
  db,
  projectId,
  phase,
  visitCount,
  questionData,
  nutritionData,
  log,
) {
  const payload = {
    project: projectId,
    phase,
    visit_count: visitCount,
    question_data: JSON.stringify(questionData),
    nutrition_data: JSON.stringify(nutritionData),
  };

  const existing = await db.listDocuments(DB_ID, SUMMARIES_COL, [
    Query.equal("project", projectId),
    Query.equal("phase", phase),
    Query.limit(1),
  ]);

  if (existing.documents.length > 0) {
    await db.updateDocument(
      DB_ID,
      SUMMARIES_COL,
      existing.documents[0].$id,
      payload,
    );
    log(`    updated ${phase} summary`);
  } else {
    await db.createDocument(DB_ID, SUMMARIES_COL, "unique()", payload);
    log(`    created ${phase} summary`);
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

export default async ({ req, res, log, error }) => {
  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(process.env.APPWRITE_API_KEY);

  const db = new Databases(client);

  try {
    log("Loading question key map…");
    const questionKeyMap = await loadQuestionKeyMap(db);
    log(`Loaded ${questionKeyMap.size} question(s)`);

    const projects = await listAll(db, PROJECTS_COL, []);
    log(`Found ${projects.length} project(s)`);

    for (const project of projects) {
      log(`\nProject: ${project.name || project.$id}`);

      try {
        for (const phase of PHASES) {
          log(`  Phase: ${phase}`);

          const visits = await listAll(db, VISITS_COL, [
            Query.equal("project", project.$id),
            Query.equal("phase", phase),
          ]);
          log(`  Visits: ${visits.length}`);

          const visitIds = visits.map((v) => v.$id);
          const questionData = await aggregatePhase(
            db,
            visitIds,
            questionKeyMap,
            log,
          );
          const nutritionData = await aggregateNutrition(
            db,
            project.$id,
            phase,
          );

          await upsertSummary(
            db,
            project.$id,
            phase,
            visits.length,
            questionData,
            nutritionData,
            log,
          );
        }
      } catch (projectErr) {
        error(`  Failed for project ${project.$id}: ${projectErr.message}`);
      }
    }

    return res.json({
      success: true,
      projects: projects.length,
      timestamp: new Date().toISOString(),
    });
  } catch (fatalErr) {
    error(`Fatal: ${fatalErr.message}`);
    return res.json({ success: false, error: fatalErr.message }, 500);
  }
};
