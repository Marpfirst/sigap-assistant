import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";

/**
 * Called once a day by the Vercel cron in vercel.json.
 *
 * Supabase pauses a free-tier project after about a week without requests,
 * and a paused project takes the whole demo down: every chat fails at its
 * first query. One cheap read a day keeps the project counted as active.
 *
 * When CRON_SECRET is set, Vercel sends it as a bearer token and anything
 * else is turned away. Without it the route is open, which costs one row
 * count per call and nothing from the model.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { error } = await db()
    .from("conversations")
    .select("id", { count: "exact", head: true });

  if (error)
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
