import { NextResponse } from "next/server";

/** env 누락 체크 */
function missing(...keys: string[]) {
  return keys.filter((k) => !process.env[k] || process.env[k]!.trim() === "");
}

/** 워드프레스에 넣기 전에 마크다운/코드블록을 HTML로 최대한 정리 */
function prepareWpHtml(raw: string): string {
  if (!raw) return "";

  // 1) 줄바꿈 정리
  let text = raw.replace(/\r\n/g, "\n");

  // 2) “```json ...```” 같은 fenced code block에서 JSON-LD를 script로 변환
  // - json 블록은 <script type="application/ld+json">로 감쌈
  // - 기타 코드블록은 fence만 제거하고 내용만 남김
  text = text.replace(/```(\w+)?\n([\s\S]*?)```/g, (_m, lang, body) => {
    const l = String(lang || "").toLowerCase().trim();
    const inner = String(body || "").trim();

    // JSON-LD로 보이는 경우 (schema)
    const looksLikeSchema =
      inner.includes('"@context"') || inner.includes("'@context'") || inner.includes("https://schema.org");

    if (l === "json" || looksLikeSchema) {
      // </script> 방지
      const safeJson = inner.replace(/<\/script>/gi, "<\\/script>");
      return `\n<script type="application/ld+json">\n${safeJson}\n</script>\n`;
    }

    // 기타는 fence만 제거(그대로 노출 방지)
    return `\n${inner}\n`;
  });

  // 3) “슬러그: …” 같은 안내 줄이 content에 들어오면 제거 (슬러그는 별도 필드로 처리)
  text = text.replace(/^\s*슬러그\s*:\s*.+$/gim, "").trim();

  // 4) H1(# )은 본문에서 제거 (워드프레스 title로 이미 들어가니까)
  text = text.replace(/^\s*#\s+.+$/gm, "").trim();

  // 5) 대표이미지 안내문을 <img>로 바꾸기 (src 없으면 빈값)
  // 예: 대표이미지 안내문: ... (alt="...") 또는 (alt=”...”)
  text = text.replace(
    /^대표이미지\s*안내문\s*:\s*(.+)$/gim,
    (_m, line) => {
      const s = String(line || "");
      const altMatch =
        s.match(/alt\s*=\s*["“”](.+?)["“”]/i) || s.match(/alt\s*=\s*'(.+?)'/i);
      const alt = altMatch ? altMatch[1] : s;
      const safeAlt = alt.replace(/"/g, "&quot;").trim();
      return `<p><img src="" alt="${safeAlt}" /></p>`;
    }
  );

  // 6) 마크다운 헤딩 ##, ### 를 HTML로
  text = text
    .replace(/^\s*####\s+(.+)$/gm, "<h4>$1</h4>")
    .replace(/^\s*###\s+(.+)$/gm, "<h3>$1</h3>")
    .replace(/^\s*##\s+(.+)$/gm, "<h2>$1</h2>");

  // 7) 불릿(-, –, •) 리스트를 <ul><li>로 변환
  // 간단 변환: 연속된 불릿 라인을 묶어서 ul 생성
  const lines = text.split("\n");
  const out: string[] = [];
  let inUl = false;

  const flushUl = () => {
    if (inUl) {
      out.push("</ul>");
      inUl = false;
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();

    // 헤딩/스크립트/이미지/ul 닫기 처리
    const isBlock =
      trimmed.startsWith("<h2>") ||
      trimmed.startsWith("<h3>") ||
      trimmed.startsWith("<h4>") ||
      trimmed.startsWith("<script") ||
      trimmed.startsWith("</script>") ||
      trimmed.startsWith("<img") ||
      trimmed.startsWith("<p><img") ||
      trimmed.startsWith("</ul>") ||
      trimmed.startsWith("<ul>");

    const bulletMatch = trimmed.match(/^[-–•*]\s+(.+)$/);

    if (bulletMatch) {
      if (!inUl) {
        flushUl();
        out.push("<ul>");
        inUl = true;
      }
      out.push(`<li>${bulletMatch[1]}</li>`);
      continue;
    }

    // 불릿이 아니면 ul 닫기
    flushUl();

    // 빈 줄은 문단 구분
    if (!trimmed) {
      out.push("");
      continue;
    }

    // 이미 HTML 블록이면 그대로
    if (isBlock || trimmed.startsWith("<p>") || trimmed.startsWith("</p>")) {
      out.push(line);
      continue;
    }

    // 일반 텍스트는 p로 감싸기 (과도한 변환 방지 위해 나중에 합치면서 처리)
    out.push(line);
  }
  flushUl();

  // 8) 일반 텍스트 덩어리를 <p>로 감싸기
  const merged = out.join("\n");
  const parts = merged.split(/\n{2,}/).map((chunk) => chunk.trim()).filter(Boolean);

  const htmlParts = parts.map((chunk) => {
    // 이미 블록 HTML(헤딩, ul, script 등)면 그대로
    const startsWithBlock =
      chunk.startsWith("<h2>") ||
      chunk.startsWith("<h3>") ||
      chunk.startsWith("<h4>") ||
      chunk.startsWith("<ul>") ||
      chunk.startsWith("<script") ||
      chunk.startsWith("<p><img");

    if (startsWithBlock) return chunk;

    // 여러 줄 텍스트는 <br> 처리
    const safe = chunk.replace(/\n/g, "<br/>");
    return `<p>${safe}</p>`;
  });

  return htmlParts.join("\n");
}

export async function GET() {
  return NextResponse.json({ message: "API is working" });
}

export async function POST(req: Request) {
  // 1) 간단 보안키 체크
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

  // 4) WP endpoint
  const wpUrl = process.env.WP_URL!.replace(/\/$/, "");
  const endpoint = `${wpUrl}/wp-json/wp/v2/posts`;

  // 5) WP Basic Auth
  const token = Buffer.from(
    `${process.env.WP_USERNAME}:${process.env.WP_APP_PASSWORD}`
  ).toString("base64");

  // ✅ 핵심: content를 워드프레스용 HTML로 정리
  const htmlContent = prepareWpHtml(String(content));

  const wpPayload: any = {
    title,
    content: htmlContent,
    status,
  };

  // 예약발행
  if (status === "future" && date) wpPayload.date = date;

  // 선택 필드
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