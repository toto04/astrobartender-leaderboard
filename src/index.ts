import { randomUUID } from "node:crypto"
import { neon } from "@neondatabase/serverless"
import { type Context, Hono } from "hono"
import { cors } from "hono/cors"
import { getConnInfo } from "hono/vercel"

// from https://github.com/Super-Genius/ElementalEngine2/blob/master/Common/Databases/BadWords.dbx
import badWords from "./words.json" with { type: "json" }

const MIN_SESSION_AGE_MS = 45 * 1000
const MAX_SESSION_AGE_MS = 20 * 60 * 1000
const SCORE_MAX = 10_000
const RESULT_LIMIT = 1000

const connectionString = process.env.DATABASE_URL

if (!connectionString) {
  throw new Error("DATABASE_URL is required")
}

const sql = neon(connectionString)
const app = new Hono()

const parseOptionalNumber = (value?: string | null) => {
  if (value === undefined || value === null || value === "") return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const handleError = (c: Context, error: unknown) => {
  console.error(error)
  return c.json({ error: "Internal server error" }, 500)
}

app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  })
)

app.get("/", async (c) => {
  try {
    const gigParam = c.req.query("gig")
    const shiftParam = c.req.query("shift")

    const gigId = parseOptionalNumber(gigParam)
    const shiftId = parseOptionalNumber(shiftParam)

    if (gigParam && gigId === null) {
      return c.json({ error: "Invalid gig value" }, 400)
    }

    if (shiftParam && shiftId === null) {
      return c.json({ error: "Invalid shift value" }, 400)
    }

    const filters = [] as ReturnType<typeof sql>[]

    if (gigId !== null) {
      filters.push(sql`gig_id = ${gigId}`)
    }

    if (shiftId !== null) {
      filters.push(sql`shift_id = ${shiftId}`)
    }

    const andClause = filters.length > 1 ? sql`AND ${filters[1]}` : sql``
    const whereClause = filters.length ? sql`WHERE ${filters[0]} ${andClause}` : sql``

    const rows = await sql`
      SELECT id, gig_id, shift_id, player_name, score
      FROM hi_scores
      ${whereClause}
      ORDER BY score DESC
      LIMIT ${RESULT_LIMIT}
    `

    return c.json({ count: rows.length, rows })
  } catch (error) {
    return handleError(c, error)
  }
})

app.get("/words", (c) => {
  return c.json(badWords)
})

app.post("/start", async (c) => {
  try {
    const token = randomUUID()
    const issued_at = new Date().toISOString()

    await sql`INSERT INTO sessions (token, issued_at) VALUES (${token}, ${issued_at})`

    return c.json({ token, issued_at })
  } catch (error) {
    return handleError(c, error)
  }
})

app.post("/submit-score", async (c) => {
  const info = getConnInfo(c)
  let body: unknown

  try {
    body = await c.req.json()
  } catch (_) {
    return c.json({ error: "Invalid JSON body" }, 400)
  }

  try {
    if (!body || typeof body !== "object") {
      return c.json({ error: "Request body must be an object" }, 400)
    }

    const { token, player_name, score, gig_id, shift_id } = body as Record<string, unknown>

    if (typeof token !== "string" || token.trim().length === 0) {
      return c.json({ error: "Missing or invalid token" }, 400)
    }

    const playerName = typeof player_name === "string" ? player_name.trim().toLowerCase() : ""
    if (playerName.length !== 3 || badWords.includes(playerName)) {
      return c.json({ error: "Missing or invalid player_name" }, 400)
    }

    const scoreValue = Number(score)

    if (!Number.isFinite(scoreValue) || scoreValue < 10 || scoreValue > SCORE_MAX) {
      return c.json({ error: "Score must be between 10 and 10,000" }, 400)
    }

    const gigValue = Number(gig_id)
    const shiftValue = Number(shift_id)

    if (!Number.isInteger(gigValue) || !Number.isInteger(shiftValue)) {
      return c.json({ error: "gig_id and shift_id must be integers" }, 400)
    }

    const sessionRows = await sql`SELECT token, issued_at FROM sessions WHERE token = ${token}`
    if (!sessionRows.length) {
      console.error("No session found for token:", token)
      return c.json({ error: "Invalid or expired session token" }, 400)
    }
    await sql`DELETE FROM sessions WHERE token = ${token}`
    await sql`DELETE FROM sessions WHERE issued_at < (now() - '25 minutes'::interval);`

    const issuedAtMs = Date.parse(sessionRows[0].issued_at)

    if (Number.isNaN(issuedAtMs)) {
      console.error("Invalid issued_at date for token:", token, "issued_at:", sessionRows[0].issued_at)
      return c.json({ error: "Invalid or expired session token" }, 400)
    }

    const ageMs = Date.now() - issuedAtMs

    if (ageMs < MIN_SESSION_AGE_MS) {
      console.error("Session token used too quickly:", token, "ageMs:", ageMs, "issued_at:", sessionRows[0].issued_at)
      return c.json({ error: "Invalid or expired session token" }, 400)
    }

    if (ageMs > MAX_SESSION_AGE_MS) {
      console.error("Session token expired:", token, "ageMs:", ageMs, "issued_at:", sessionRows[0].issued_at)
      return c.json({ error: "Invalid or expired session token" }, 400)
    }

    const inserted = await sql`
      INSERT INTO hi_scores (gig_id, shift_id, player_name, score, ip_addr)
      VALUES (${gigValue}, ${shiftValue}, ${playerName.toUpperCase()}, ${scoreValue}, ${info.remote.address ?? "unknown"})
      RETURNING id, gig_id, shift_id, player_name, score
    `

    return c.json({ result: inserted[0] })
  } catch (error) {
    return handleError(c, error)
  }
})

export default app
