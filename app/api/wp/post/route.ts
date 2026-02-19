import { NextRequest, NextResponse } from "next/server"

type PublishType = "draft" | "publish" | "future"
type Version = "V1" | "V2" | "V3" | "V4"

export async function POST(req: NextRequest) {
  try {
    // 0) API 인증 (너의 서버 보호용)
    const apiKey = req.headers.get("x-api-key")
    if (!apiKey || apiKey !== process.env.API_KEY) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // 1) 입력값
    const {
      keyword,
      hotelId,
      version = "V1",
      publishType = "draft",
      category = 1
    }: {
      keyword?: string
      hotelId?: string
      version?: Version
      publishType?: PublishType
      category?: number
    } = await req.json()

    if (!hotelId) {
      return NextResponse.json({ error: "hotelId is required" }, { status: 400 })
    }

    // 2) Agoda hotelId 기반 상세 조회
    const rawHotel = await agodaGetHotelById(hotelId)
    const hotel = normalizeHotel(rawHotel)

    // 3) 제휴 링크 생성
    const affiliateUrl = generateAffiliateUrl(hotelId)

    // 4) 글 HTML 생성
    const title = `${hotel.name} | ${keyword ?? "호텔"} 예약 가이드`
    const contentHtml = generatePostHTML({
      keyword: keyword ?? "호텔",
      hotel,
      affiliateUrl,
      version
    })

    // 5) WP 발행
    const wp = await publishToWordPress({
      title,
      content: contentHtml,
      publishType,
      category: Number(category)
    })

    return NextResponse.json({ success: true, wp })
  } catch (err: any) {
    // Vercel에서 보기 좋게
    return NextResponse.json(
      {
        error: err?.message ?? "Unknown error",
        detail: err?.detail ?? null
      },
      { status: 502 }
    )
  }
}

////////////////////////////////////////////////////////////
// ✅ Agoda: hotelId 전용 조회 (additional 금지)
////////////////////////////////////////////////////////////

async function agodaGetHotelById(hotelId: string) {
  const AGODA_URL = "https://affiliateapi7643.agoda.com/affiliateservice/lt_v1"

  const AGODA_SITE_ID = process.env.AGODA_SITE_ID
  const AGODA_API_KEY = process.env.AGODA_API_KEY

  // 🔎 환경변수 존재 여부(서버 로그에서 true/false로 확인)
  console.log("✅ AGODA_SITE_ID_EXISTS =", !!AGODA_SITE_ID)
  console.log("✅ AGODA_API_KEY_EXISTS =", !!AGODA_API_KEY)

  if (!AGODA_SITE_ID) {
    const e: any = new Error("Missing env: AGODA_SITE_ID")
    e.detail = { missing: "AGODA_SITE_ID" }
    throw e
  }
  if (!AGODA_API_KEY) {
    const e: any = new Error("Missing env: AGODA_API_KEY")
    e.detail = { missing: "AGODA_API_KEY" }
    throw e
  }

  // ✅ hotelId 검색일 때는 criteria.hotelId만 보내야 함 (추가필드 절대 금지)
  const payload = {
    criteria: {
      hotelId: [Number(hotelId)]
    }
  }

  console.log("✅ AGODA_PAYLOAD =", JSON.stringify(payload))

  const res = await fetch(AGODA_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",

      // ✅ 인증 헤더 (형식이 계정/문서마다 달라서 최대 호환으로 같이 보냄)
      "x-api-key": AGODA_API_KEY,
      "x-site-id": AGODA_SITE_ID,
      "X-API-Key": AGODA_API_KEY,
      "SiteId": AGODA_SITE_ID,
      "ApiKey": AGODA_API_KEY,

      // 혹시 Authorization 방식도 요구할 수 있어 같이 유지
      Authorization: AGODA_API_KEY
    },
    body: JSON.stringify(payload)
  })

  const text = await res.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    // JSON 파싱 실패해도 text로 에러 확인 가능
  }

  if (!res.ok) {
    console.error("❌ AGODA_ERROR_RESPONSE =", text)
    const e: any = new Error(
      `Agoda API failed: ${res.status} ${typeof text === "string" ? text : ""}`
    )
    e.detail = json ?? text
    throw e
  }

  const results = json?.results
  if (!Array.isArray(results) || results.length === 0) {
    const e: any = new Error("Agoda fetch failed: no results")
    e.detail = json
    throw e
  }

  return results[0]
}

function normalizeHotel(raw: any) {
  return {
    name: raw?.name ?? raw?.hotelName ?? "Hotel",
    address: raw?.address ?? raw?.hotelAddress ?? "",
    description: raw?.description ?? raw?.hotelDescription ?? "",
    reviewScore: raw?.reviewScore ?? raw?.review_score ?? raw?.rating ?? "",
    imageURL:
      raw?.imageURL ??
      raw?.imageUrl ??
      raw?.image ??
      raw?.thumbnailUrl ??
      ""
  }
}

////////////////////////////////////////////////////////////
// ✅ Agoda 제휴 URL 생성
////////////////////////////////////////////////////////////

function generateAffiliateUrl(hotelId: string) {
  const siteId = process.env.AGODA_SITE_ID
  if (!siteId) throw new Error("Missing env: AGODA_SITE_ID")
  return `https://www.agoda.com/partners/partnersearch.aspx?hid=${encodeURIComponent(
    hotelId
  )}&cid=${encodeURIComponent(siteId)}`
}

////////////////////////////////////////////////////////////
// ✅ HTML 생성 (이미지 + CTA + FAQ 스키마)
////////////////////////////////////////////////////////////

function generatePostHTML({
  keyword,
  hotel,
  affiliateUrl,
  version
}: {
  keyword: string
  hotel: { name: string; address: string; description: string; reviewScore: any; imageURL: string }
  affiliateUrl: string
  version: Version
}) {
  const imageHtml = hotel.imageURL
    ? `<div style="text-align:center;margin:18px 0;">
         <img src="${escapeHtmlAttr(hotel.imageURL)}" alt="${escapeHtmlAttr(
        hotel.name
      )}" style="max-width:100%;border-radius:12px;" />
       </div>`
    : ""

  const ctaHtml = `
  <div style="margin:28px 0;text-align:center;">
    <a href="${escapeHtmlAttr(affiliateUrl)}" target="_blank" rel="nofollow noopener"
       style="background:#ff5a5f;color:#fff;padding:14px 22px;border-radius:10px;text-decoration:none;font-weight:bold;display:inline-block;">
       👉 아고다 최저가 확인하기
    </a>
  </div>
  `

  const faqSchema = `
<script type="application/ld+json">
{
  "@context":"https://schema.org",
  "@type":"FAQPage",
  "mainEntity":[
    {
      "@type":"Question",
      "name":"${escapeJsonString(hotel.name)} 위치는 어디인가요?",
      "acceptedAnswer":{"@type":"Answer","text":"${escapeJsonString(hotel.address || "주소 정보는 예약 페이지에서 확인할 수 있어요.")}"}
    },
    {
      "@type":"Question",
      "name":"${escapeJsonString(hotel.name)} 평점은 어떤가요?",
      "acceptedAnswer":{"@type":"Answer","text":"현재 기준 평점은 ${escapeJsonString(String(hotel.reviewScore || "정보 없음"))} 입니다."}
    }
  ]
}
</script>
  `.trim()

  const intro = `
  <h2>${escapeHtml(keyword)} 추천 호텔: ${escapeHtml(hotel.name)}</h2>
  <p>${escapeHtml(hotel.description || `${hotel.name}의 예약 정보를 정리했어요.`)}</p>
  <ul>
    ${hotel.address ? `<li><b>주소</b>: ${escapeHtml(hotel.address)}</li>` : ""}
    ${hotel.reviewScore ? `<li><b>평점</b>: ${escapeHtml(String(hotel.reviewScore))}</li>` : ""}
  </ul>
  `

  let body = ""
  switch (version) {
    case "V2":
      body = `
      <h3>장점 요약</h3>
      <ul>
        <li>위치/접근성, 후기 포인트를 중심으로 비교하세요.</li>
        <li>성수기엔 가격 변동이 크니 자주 확인하는 게 좋아요.</li>
      </ul>
      `
      break
    case "V3":
      body = `
      <h3>${escapeHtml(keyword)} 일정 체크리스트</h3>
      <ol>
        <li>체크인/체크아웃 시간</li>
        <li>취소/환불 조건</li>
        <li>교통/주변 편의시설</li>
      </ol>
      `
      break
    case "V4":
      body = `
      <h3>요약</h3>
      <p><b>${escapeHtml(hotel.name)}</b> 예약은 아래 버튼에서 바로 확인할 수 있어요.</p>
      <p>FAQ 스키마가 자동 삽입되어 검색엔진에도 도움이 됩니다.</p>
      `
      break
    default:
      body = `
      <h3>한 줄 결론</h3>
      <p>${escapeHtml(hotel.name)}은(는) ${escapeHtml(keyword)} 조건에서 후보로 볼 만합니다.</p>
      `
  }

  return `
  ${imageHtml}
  ${intro}
  ${body}
  ${ctaHtml}
  ${faqSchema}
  `
}

////////////////////////////////////////////////////////////
// ✅ WordPress 발행
////////////////////////////////////////////////////////////

async function publishToWordPress({
  title,
  content,
  publishType,
  category
}: {
  title: string
  content: string
  publishType: PublishType
  category: number
}) {
  const WP_URL = process.env.WP_URL
  const WP_USERNAME = process.env.WP_USERNAME
  const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD

  if (!WP_URL) throw new Error("Missing env: WP_URL")
  if (!WP_USERNAME) throw new Error("Missing env: WP_USERNAME")
  if (!WP_APP_PASSWORD) throw new Error("Missing env: WP_APP_PASSWORD")

  const status =
    publishType === "publish" ? "publish" : publishType === "future" ? "future" : "draft"

  const auth = Buffer.from(`${WP_USERNAME}:${WP_APP_PASSWORD}`).toString("base64")

  const res = await fetch(`${WP_URL.replace(/\/$/, "")}/wp-json/wp/v2/posts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${auth}`
    },
    body: JSON.stringify({
      title,
      content,
      status,
      categories: [Number(category)]
    })
  })

  const text = await res.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {}

  if (!res.ok) {
    const e: any = new Error(`WordPress publish failed: ${res.status}`)
    e.detail = json ?? text
    throw e
  }

  return json
}

////////////////////////////////////////////////////////////
// ✅ 유틸
////////////////////////////////////////////////////////////

function escapeHtml(s: string) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
}

function escapeHtmlAttr(s: string) {
  return escapeHtml(s)
}

function escapeJsonString(s: string) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ")
}