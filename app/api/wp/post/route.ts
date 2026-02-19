import { NextResponse } from "next/server";

function missing(...keys: string[]) {
  return keys.filter((k) => !process.env[k] || process.env[k]!.trim() === "");
}

function slugify(input: string) {
  return input
    .toLowerCase()
    .trim()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** HTML로 강제(마크다운/코드블록 깨짐 방지 + JSON-LD 스크립트화) */
function prepareWpHtml(raw: string): string {
  if (!raw) return "";
  let text = raw.replace(/\r\n/g, "\n");

  // fenced code block 처리: json/schema면 <script type="application/ld+json">로
  text = text.replace(/```(\w+)?\n([\s\S]*?)```/g, (_m, lang, body) => {
    const l = String(lang || "").toLowerCase().trim();
    const inner = String(body || "").trim();
    const looksLikeSchema = inner.includes('"@context"') || inner.includes("https://schema.org");
    if (l === "json" || looksLikeSchema) {
      const safe = inner.replace(/<\/script>/gi, "<\\/script>");
      return `\n<script type="application/ld+json">\n${safe}\n</script>\n`;
    }
    return `\n${inner}\n`;
  });

  // 본문에 H1(# ) 있으면 제거(제목은 title에만)
  text = text.replace(/^\s*#\s+.+$/gm, "").trim();

  // 마크다운 헤딩 -> HTML
  text = text
    .replace(/^\s*####\s+(.+)$/gm, "<h4>$1</h4>")
    .replace(/^\s*###\s+(.+)$/gm, "<h3>$1</h3>")
    .replace(/^\s*##\s+(.+)$/gm, "<h2>$1</h2>");

  // 간단 리스트(-, –, •) -> <ul><li>
  const lines = text.split("\n");
  const out: string[] = [];
  let inUl = false;
  const closeUl = () => {
    if (inUl) out.push("</ul>");
    inUl = false;
  };

  for (const line of lines) {
    const t = line.trim();
    const bullet = t.match(/^[-–•*]\s+(.+)$/);

    if (bullet) {
      if (!inUl) {
        out.push("<ul>");
        inUl = true;
      }
      out.push(`<li>${bullet[1]}</li>`);
      continue;
    }

    closeUl();

    if (!t) {
      out.push("");
      continue;
    }

    // 이미 HTML 블록이면 그대로
    if (t.startsWith("<h2>") || t.startsWith("<h3>") || t.startsWith("<h4>") || t.startsWith("<ul>") || t.startsWith("<script")) {
      out.push(line);
      continue;
    }

    out.push(line);
  }
  closeUl();

  // 문단 <p> 처리
  const merged = out.join("\n");
  const parts = merged.split(/\n{2,}/).map((c) => c.trim()).filter(Boolean);

  return parts
    .map((chunk) => {
      const isBlock =
        chunk.startsWith("<h2>") ||
        chunk.startsWith("<h3>") ||
        chunk.startsWith("<h4>") ||
        chunk.startsWith("<ul>") ||
        chunk.startsWith("<script");
      if (isBlock) return chunk;
      return `<p>${chunk.replace(/\n/g, "<br/>")}</p>`;
    })
    .join("\n");
}

/** Agoda LT API 호출: cityId 또는 hotelId 필요 (문서: city search / hotel list search) */
async function agodaSearch(params: {
  cityId?: number;
  hotelId?: number;
  checkInDate: string;
  checkOutDate: string;
  language?: string;
  currency?: string;
  maxResult?: number;
}) {
  const need = missing("AGODA_SITE_ID", "AGODA_API_KEY");
  if (need.length) throw new Error(`Missing env vars: ${need.join(", ")}`);

  const endpoint = "http://affiliateapi7643.agoda.com/affiliateservice/lt_v1"; // doc :contentReference[oaicite:3]{index=3}
  const siteId = process.env.AGODA_SITE_ID!;
  const apiKey = process.env.AGODA_API_KEY!;

  const body: any = {
    criteria: {
      additional: {
        currency: params.currency || "USD",
        discountOnly: false,
        language: params.language || "en-us",
        maxResult: params.maxResult ?? 10,
        minimumReviewScore: 0,
        minimumStarRating: 0,
        occupancy: { numberOfAdult: 2, numberOfChildren: 0 },
        sortBy: "Recommended",
      },
      checkInDate: params.checkInDate,
      checkOutDate: params.checkOutDate,
    },
  };

  if (params.hotelId) body.criteria.hotelId = [params.hotelId];
  else if (params.cityId) body.criteria.cityId = params.cityId;
  else throw new Error("Agoda requires cityId or hotelId");

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept-Encoding": "gzip,deflate",
      // doc: Authorization siteid:apikey :contentReference[oaicite:4]{index=4}
      Authorization: `${siteId}:${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Agoda API failed: ${res.status} ${JSON.stringify(data)}`);

  const first = data?.results?.[0];
  // doc: imageURL / landingURL / hotelId / hotelName :contentReference[oaicite:5]{index=5}
  if (!first?.landingURL) throw new Error("Agoda returned no landingURL");
  return {
    hotelId: first.hotelId,
    hotelName: first.hotelName,
    imageURL: first.imageURL,
    landingURL: first.landingURL,
    dailyRate: first.dailyRate,
    currency: first.currency,
    reviewScore: first.reviewScore,
    starRating: first.starRating,
    raw: first,
  };
}

/** WP Basic Auth 헤더 */
function wpAuthHeader() {
  const token = Buffer.from(`${process.env.WP_USERNAME}:${process.env.WP_APP_PASSWORD}`).toString("base64");
  return `Basic ${token}`;
}

/** 카테고리 이름 -> ID (없으면 생성) */
async function ensureCategoryId(wpUrl: string, name: string): Promise<number | null> {
  if (!name?.trim()) return null;
  const searchUrl = `${wpUrl}/wp-json/wp/v2/categories?search=${encodeURIComponent(name)}&per_page=100`;
  const res = await fetch(searchUrl, { headers: { Authorization: wpAuthHeader() } });
  const list = await res.json().catch(() => []);
  const found = Array.isArray(list) ? list.find((c) => String(c?.name).toLowerCase() === name.toLowerCase()) : null;
  if (found?.id) return found.id;

  // 생성
  const create = await fetch(`${wpUrl}/wp-json/wp/v2/categories`, {
    method: "POST",
    headers: { Authorization: wpAuthHeader(), "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const created = await create.json().catch(() => ({}));
  if (!create.ok) return null;
  return created?.id ?? null;
}

/** 이미지 URL -> WP media 업로드 -> mediaId */
async function uploadFeaturedImage(wpUrl: string, imageUrl: string, alt: string): Promise<number | null> {
  if (!imageUrl) return null;

  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) return null;

  const buf = Buffer.from(await imgRes.arrayBuffer());
  const fileName = `${slugify(alt || "hotel")}.jpg`;

  const mediaRes = await fetch(`${wpUrl}/wp-json/wp/v2/media`, {
    method: "POST",
    headers: {
      Authorization: wpAuthHeader(),
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Content-Type": imgRes.headers.get("content-type") || "image/jpeg",
    },
    body: buf,
  });

  const media = await mediaRes.json().catch(() => ({}));
  if (!mediaRes.ok) return null;

  // alt_text 설정(선택)
  if (media?.id) {
    await fetch(`${wpUrl}/wp-json/wp/v2/media/${media.id}`, {
      method: "POST",
      headers: { Authorization: wpAuthHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({ alt_text: alt }),
    }).catch(() => {});
  }

  return media?.id ?? null;
}

/** 버전별 HTML 본문 생성 (예약 버튼 3회 + JSON-LD FAQ) */
function buildHtml(args: {
  version: "V1" | "V2" | "V3" | "V4" | "random";
  keyword: string;
  hotelName: string;
  landingURL: string;
  imageId?: number | null;
  imageAlt: string;
  imageUrl?: string;
  dailyRate?: number;
  currency?: string;
  reviewScore?: number;
  starRating?: number;
}) {
  const v = args.version === "random"
    ? (["V1", "V2", "V3", "V4"][Math.floor(Math.random() * 4)] as any)
    : args.version;

  const cta = (label = "해당 호텔 예약하기") =>
    `<p><a href="${args.landingURL}" target="_blank" rel="sponsored nofollow noopener">${label}</a></p>`;

  const heroImg = args.imageUrl
    ? `<p><img src="${args.imageUrl}" alt="${args.imageAlt}" /></p>`
    : `<p><img src="" alt="${args.imageAlt}" /></p>`;

  const quick = `
<h2>핵심 요약</h2>
<ul>
  <li>호텔명: ${args.hotelName}</li>
  <li>평점/성급: ${args.reviewScore ?? "-"} / ${args.starRating ?? "-"}</li>
  <li>가격(참고): ${args.dailyRate ?? "-"} ${args.currency ?? ""}</li>
</ul>
${cta("지금 최저가 확인하기")}
`;

  const faqJson = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": [
      { "@type": "Question", "name": "체크인/체크아웃 시간은?", "acceptedAnswer": { "@type": "Answer", "text": "호텔 정책에 따라 다르며 예약 페이지에서 최신 정보를 확인하세요." } },
      { "@type": "Question", "name": "무료 취소가 가능한가요?", "acceptedAnswer": { "@type": "Answer", "text": "요금제에 따라 다릅니다. 예약 단계에서 무료 취소 여부를 확인하세요." } },
      { "@type": "Question", "name": "조식 포함 옵션이 있나요?", "acceptedAnswer": { "@type": "Answer", "text": "플랜에 따라 제공됩니다. 예약 페이지에서 조식 포함 여부를 확인하세요." } }
    ]
  };

  const schema = `<script type="application/ld+json">\n${JSON.stringify(faqJson)}\n</script>`;

  if (v === "V2") {
    // 비교형(간단 TOP5 예시)
    return `
${heroImg}
${quick}
<h2>${args.keyword} TOP5</h2>
<ol>
  <li>${args.hotelName} (추천)</li>
  <li>대안 호텔 A</li>
  <li>대안 호텔 B</li>
  <li>대안 호텔 C</li>
  <li>대안 호텔 D</li>
</ol>
${cta("TOP5 중 1위 호텔 예약하기")}
<h2>선택 팁</h2>
<p>위치/후기/가격을 함께 보고 결정하세요.</p>
${cta("객실 요금 다시 확인하기")}
${schema}
`;
  }

  if (v === "V3") {
    // 정보형
    return `
${heroImg}
${quick}
<h2>위치 & 이동 팁</h2>
<p>${args.hotelName} 주변의 교통/동선 기준으로 이동이 편한 구역을 먼저 잡는 것이 핵심입니다.</p>
${cta()}
<h2>여행 목적별 추천</h2>
<ul>
  <li>출장: 조용한 객실/이동 동선</li>
  <li>커플: 야경/핫플 접근성</li>
  <li>가족: 객실 크기/편의시설</li>
</ul>
${cta("예약 가능한 날짜 확인하기")}
${schema}
`;
  }

  if (v === "V4") {
    // FAQ형
    return `
${heroImg}
${quick}
<h2>자주 묻는 질문</h2>
<h3>체크인/체크아웃은?</h3>
<p>예약 페이지 기준이 가장 정확합니다.</p>
<h3>취소/환불 규정은?</h3>
<p>요금제에 따라 다릅니다.</p>
<h3>조식 포함이 좋아요?</h3>
<p>일정이 빠듯하면 포함 옵션이 편합니다.</p>
${cta("예약 조건 확인하기")}
${schema}
`;
  }

  // V1 리뷰형(기본)
  return `
${heroImg}
${quick}
<h2>객실 컨디션</h2>
<p>${args.hotelName}는 전반적으로 무난한 컨디션을 기대할 수 있습니다. 체크인 전 최신 후기/사진을 확인하세요.</p>
${cta()}
<h2>부대시설 & 조식</h2>
<p>조식/피트니스 등은 플랜/시즌에 따라 달라질 수 있습니다.</p>
${cta("프로모션 확인하기")}
<h2>추천 대상</h2>
<ul>
  <li>가성비/동선 중심</li>
  <li>단기 여행/출장</li>
</ul>
${schema}
`;
}

export async function GET() {
  return NextResponse.json({ message: "API is working" });
}

export async function POST(req: Request) {
  // 1) API 키 체크
  const apiKey = req.headers.get("x-api-key") || "";
  if (!process.env.API_KEY || apiKey !== process.env.API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 2) WP env 체크
  const need = missing("WP_URL", "WP_USERNAME", "WP_APP_PASSWORD", "AGODA_SITE_ID", "AGODA_API_KEY");
  if (need.length) {
    return NextResponse.json({ error: "Missing env vars", missing: need }, { status: 500 });
  }

  // 3) body (GPTs에서 보내는 값)
  const body = await req.json().catch(() => ({}));

  // WP 발행 관련
  const publishType = (body.publishType || body.status || "draft") as "draft" | "future" | "publish";
  const date = body.date; // future일 때 ISO
  const version = (body.version || "random") as "V1" | "V2" | "V3" | "V4" | "random";
  const categoryName = String(body.category || "").trim();

  // Agoda 조회 입력(둘 중 하나는 필요)
  const cityId = body.cityId ? Number(body.cityId) : undefined;
  const hotelId = body.hotelId ? Number(body.hotelId) : undefined;

  // 제목 키워드/호텔 키워드
  const keyword = String(body.keyword || body.hotelQuery || body.title || "").trim();
  if (!keyword) {
    return NextResponse.json({ error: "keyword(hotelQuery) is required" }, { status: 400 });
  }

  // 체크인/아웃(없으면 기본: 내일~모레)
  const today = new Date();
  const toYMD = (d: Date) => d.toISOString().slice(0, 10);
  const checkIn = body.checkInDate || toYMD(new Date(today.getTime() + 24 * 3600 * 1000));
  const checkOut = body.checkOutDate || toYMD(new Date(today.getTime() + 2 * 24 * 3600 * 1000));

  // 4) Agoda에서 landingURL/imageURL 가져오기
  let agoda;
  try {
    agoda = await agodaSearch({ cityId, hotelId, checkInDate: checkIn, checkOutDate: checkOut });
  } catch (e: any) {
    return NextResponse.json({ error: "Agoda fetch failed", detail: String(e?.message || e) }, { status: 502 });
  }

  // 5) WP 카테고리 ID 확보(이름 기반)
  const wpUrl = process.env.WP_URL!.replace(/\/$/, "");
  const categoryId = categoryName ? await ensureCategoryId(wpUrl, categoryName) : null;

  // 6) 이미지 업로드 + featured_media
  const imageAlt = `${agoda.hotelName} 객실/외관`;
  const featuredMediaId = await uploadFeaturedImage(wpUrl, agoda.imageURL, imageAlt);

  // 7) 버전별 HTML 생성 + CTA 링크(landingURL)
  const html = buildHtml({
    version,
    keyword,
    hotelName: agoda.hotelName,
    landingURL: agoda.landingURL,
    imageAlt,
    imageUrl: agoda.imageURL,
    dailyRate: agoda.dailyRate,
    currency: agoda.currency,
    reviewScore: agoda.reviewScore,
    starRating: agoda.starRating,
  });

  // 8) WP 글 생성 payload
  const title = body.title || `${keyword} | ${agoda.hotelName}`;
  const slug = body.slug ? String(body.slug) : slugify(agoda.hotelName);

  const wpPayload: any = {
    title,
    content: prepareWpHtml(html),
    status: publishType,
    slug,
  };

  if (publishType === "future" && date) wpPayload.date = date;
  if (categoryId) wpPayload.categories = [categoryId];
  if (featuredMediaId) wpPayload.featured_media = featuredMediaId;

  // 9) WP 발행
  const res = await fetch(`${wpUrl}/wp-json/wp/v2/posts`, {
    method: "POST",
    headers: {
      Authorization: wpAuthHeader(),
      "Content-Type": "application/json",
      "User-Agent": "agoda-wp-automation/2.0",
    },
    body: JSON.stringify(wpPayload),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return NextResponse.json({ error: "WP publish failed", status: res.status, data }, { status: 502 });
  }

  return NextResponse.json({
    ok: true,
    postId: data?.id,
    link: data?.link,
    status: data?.status,
    used: {
      version,
      slug,
      categoryId,
      featuredMediaId,
      agoda: { hotelId: agoda.hotelId, landingURL: agoda.landingURL, imageURL: agoda.imageURL },
    },
  });
}