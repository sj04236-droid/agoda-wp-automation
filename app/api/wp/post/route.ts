import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { title, content, status = "draft" } = body || {};

    if (!title || !content) {
      return NextResponse.json({ error: "title/content required" }, { status: 400 });
    }

    const base = process.env.WP_BASE_URL;
    const user = process.env.WP_USER;
    const pass = process.env.WP_APP_PASSWORD;

    if (!base || !user || !pass) {
      return NextResponse.json({ error: "Missing env vars" }, { status: 500 });
    }

    const auth = Buffer.from(`${user}:${pass}`).toString("base64");

    const r = await fetch(`${base}/wp-json/wp/v2/posts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify({ title, content, status }),
    });

    const data = await r.json();
    return NextResponse.json(data, { status: r.status });
  } catch (e) {
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
export async function GET() {
  return NextResponse.json({ message: "API is working" });
}
