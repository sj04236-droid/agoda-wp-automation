import { NextRequest, NextResponse } from "next/server"

type PublishType = "draft" | "publish" | "future"

export async function POST(req: NextRequest) {
  try {
    // 0) x-api-key 인증
    const apiKey = req.headers.get("x-api-key")
    if (!apiKey || apiKey !== process.env.API_KEY) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // 1) 요청 바디 받기
    const {
      keyword,
      hotelId,
      version = "V1",
      publishType = "draft",
      category = 1
    }: {
      keyword?: string
      hotelId?: string
      version?: "V1" | "V2" | "V3" | "V4"
      publishType?: PublishType
      category?: number
    } = await req.json()

    if (!hotelId) {
      return NextResponse.json({ error: "hotelId is required" }, { status: 400 })
    }

    // 2) Agoda 호출 (hotelId 전용: criteria.hotelId만 보냄)
    const hotel = await agodaGetHotelById(hotelId)

    // 3) 제휴 링크 생성
    const affiliateUrl = generateAffiliateUrl(hotelId)

    // 4) HTML 생성 (이미지 + CTA + FAQ 스키마 포함)
    const title = `${hotel.name} | ${keyword ?? "호텔"} 예약 가이드`
    const html = generatePostHTML({
      keyword: keyword ?? "호텔",
      hotel,
      affiliateUrl,
      version
    })

    // 5) 워드프레스 발행
    const wp = await publishToWordPress({
      title,
      content: html,
      publishType: publishType ?? "draft",
      category: Number(category ?? 1)
    })

    return NextResponse.json({ success: true, wp })
  } catch (err: any) {
    // Vercel에서 보기 좋게 에러 노출
    return NextResponse.json(
      { error: err?.message ?? "Unknown error", detail: err?.detail ?? null },
      { status: 502 }
    )
  }
}

////////////////////////////////////////////////////////////
// ✅ Agoda: hotelId 전용 조회 (additional/필터 절대 금지)
////////////////////////////////////////////////////////////

async function agodaGetHotelById(hotelId: string) {
  const AGODA_API_KEY = process.env.AGODA_API_KEY
  if (!AGODA_API_KEY) throw new Error("Missing env: AGODA_API_KEY")

  // ⚠️ 너가 쓰는 엔드포인트 유지 (기존과 동일하게)
  const AGODA_URL = "https://affiliateapi7643.agoda.com/affiliateservice/lt_v1"

  // ✅ hotelId일 때는 criteria.hotelId 외에 아무것도 보내면 안 됨
  const payload = {
    criteria: {
      hotelId: [Number(hotelId)]
    }
  }

  // ✅ 디버그 로그 (Vercel Runtime Logs에서 확인 가능)
  console.log("✅ AGODA_PAYLOAD =", JSON.stringify(payload))

  const res = await fetch(AGODA_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // ⚠️ 너 프로젝트에서 Authorization을 쓰고 있어서 유지
      Authorization: AGODA_API_KEY
    },
    body: JSON.stringify(payload)
  })

  const text = await res.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    // 응답이 JSON이 아니어도 에러 메시지 보여주기 위해 text 유지
  }

  if (!res.ok) {
    // Agoda에서 준 에러를 그대로 보여주기
    const detail = json ?? text
    const e: any = new Error(`Agoda API failed: ${res.status} ${typeof detail === "string" ? detail : JSON.stringify(detail)}`)
    e.detail = detail
    throw e
  }

  // Agoda 응답 구조에 따라 results 배열에서 첫 호텔 추출
  const results = json?.results
  if (!Array.isArray(results) || results.length === 0) {
    const e: any = new Error("Agoda fetch failed")
    e.detail = json
    throw e
  }

  // 아래 필드명은 너가 이전에 쓰던 형태에 맞춘 “가드 처리”
  const first = results[0]
  const hotel = normalizeHotel(first)
  return hotel
}

function normalizeHotel(raw: any) {
  // raw에 어떤 필드가 오든, HTML 생성에 필요한 최소 필드만 보장
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
// ✅ HTML 생성 (버전별 본문 + CTA + FAQ 스키마)
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
  version: "V1" | "V2" | "V3" | "V4"
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
  <h2>${escapeHtml(keyword)} 관련 추천: ${escapeHtml(hotel.name)}</h2>
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
        <li>${escapeHtml(hotel.name)}은(는) 위치/접근성이 좋은 편인 경우가 많아요.</li>
        <li>예약 전에는 객실 사진/후기를 꼭 확인하세요.</li>
      </ul>
      <h3>예약 팁</h3>
      <p>주말/성수기에는 가격 변동이 크니, 가능한 빨리 가격을 확인하는 게 좋아요.</p>
      `
      break
    case "V3":
      body = `
      <h3>${escapeHtml(keyword)} 일정에 맞춘 체크 포인트</h3>
      <ol>
        <li>체크인/체크아웃 시간 확인</li>
        <li>취소/환불 조건 확인</li>
        <li>교통/주변 편의시설 확인</li>
      </ol>
      `
      break
    case "V4":
      body = `
      <h3>요약</h3>
      <p><b>${escapeHtml(hotel.name)}</b> 예약은 아래 버튼에서 바로 확인할 수 있어요.</p>
      <h3>자주 묻는 질문</h3>
      <p>페이지 하단 FAQ 스키마가 자동 삽입됩니다.</p>
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
// ✅ 워드프레스 발행
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
    const detail = json ?? text
    const e: any = new Error(`WordPress publish failed: ${res.status}`)
    e.detail = detail
    throw e
  }

  return json
}

////////////////////////////////////////////////////////////
// ✅ 작은 유틸
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
  // JSON 안에 들어갈 문자열용
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ")
}