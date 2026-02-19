import { NextResponse } from "next/server";

function missing(...keys: string[]) {
  return keys.filter((k) => !process.env[k] || process.env[k]!.trim() === "");
}

export async function GET() {
  return NextResponse.json({ message: "API is working" });
}

export async function POST(req: Request) {
  // 1) 간단 보안키 체크 (GPTs Action에서 x-api-key 넣을 것)
  const apiKey = req.headers.get("x-api-key") || "";
  if (!process.env.API_KEY || apiKey !== process.env.API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 2) env 체크
  const need = missing("WP_URL", "WP_USERNAME", "WP_APP_PASSWORD");
  if (need.length) {
    return NextResponse.json(
      { error: "Missing env vars", missing: need },
      { status: 500 }
    );
  }

  // 3) body
  const body = await req.json().catch(() => ({}));
  const { title, content, status, date, slug, categories, tags } = body ?? {};

  if (!title || !content || !status) {
    return NextResponse.json(
      { error: "title/content/status are required" },
      { status: 400 }
    );
  }

  const wpUrl = process.env.WP_URL!.replace(/\/$/, "");
  const endpoint = `${wpUrl}/wp-json/wp/v2/posts`;

  // 4) WP Basic Auth (username:app_password)
  const token = Buffer.from(
    `${process.env.WP_USERNAME}:${process.env.WP_APP_PASSWORD}`
  ).toString("base64");

  const wpPayload: any = { title, content, status };

  // 예약발행: status=future + date(ISO)
  if (status === "future" && date) wpPayload.date = date;

  if (slug) wpPayload.slug = slug;
  if (Array.isArray(categories)) wpPayload.categories = categories;
  if (Array.isArray(tags)) wpPayload.tags = tags;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Basic ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "agoda-wp-automation/1.0",
    },
    body: JSON.stringify(wpPayload),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    return NextResponse.json(
      { error: "WP publish failed", status: res.status, data },
      { status: 502 }
    );
  }

  return NextResponse.json({
    ok: true,
    postId: data?.id,
    link: data?.link,
    status: data?.status,
  });
}