import { NextRequest, NextResponse } from "next/server"

type PublishType = "draft" | "publish" | "future"
type Version = "V1" | "V2" | "V3" | "V4"

export async function POST(req: NextRequest) {
  try {
    // 0) 서버 보호용 x-api-key
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
  category = 1,
  checkInDate,
  checkOutDate
} = await req.json()


    if (!hotelId) {
      return NextResponse.json({ error: "hotelId is required" }, { status: 400 })
    }

    // 2) Agoda 조회
    const rawHotel = await agodaGetHotelById(hotelId, checkInDate, checkOutDate)

    const hotel = normalizeHotel(rawHotel)

    // 3) 제휴 링크
    const affiliateUrl = generateAffiliateUrl(hotelId)

    // 4) HTML 생성
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
    return NextResponse.json(
      { error: err?.message ?? "Unknown error", detail: err?.detail ?? null },
      { status: 502 }
    )
  }
}

////////////////////////////////////////////////////////////
// Agoda (hotelId 전용)
////////////////////////////////////////////////////////////
async function agodaGetHotelById(
  hotelId: string,
  checkInDate?: string,
  checkOutDate?: string
) {

  const AGODA_URL = "https://affiliateapi7643.agoda.com/affiliateservice/lt_v1"

const AGODA_AUTH = process.env.AGODA_AUTH

console.log("✅ AGODA_AUTH_EXISTS =", !!AGODA_AUTH)

if (!AGODA_AUTH) throw new Error("Missing env: AGODA_AUTH")


 const dates = getDefaultDates()
const inDate = checkInDate || dates.checkInDate
const outDate = checkOutDate || dates.checkOutDate


  // ✅ additional 절대 금지
const payload = {
  criteria: {
    // ✅ 문서 예시 필드들
    language: "ko-kr",
    currency: "KRW",
    occupancy: {
      numberOfAdult: 2,
      numberOfChildren: 0
    },

    // ✅ 호텔ID 검색
    checkInDate: inDate,
    checkOutDate: outDate,
    hotelId: [Number(hotelId)]
  }
}



  console.log("✅ AGODA_PAYLOAD =", JSON.stringify(payload))

  const res = await fetch(AGODA_URL, {
    method: "POST",
 headers: {
  "Content-Type": "application/json",
  "Accept-Encoding": "gzip,deflate",
  Authorization: AGODA_AUTH
},

    body: JSON.stringify(payload)
  })

  const text = await res.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {}

  if (!res.ok) {
    console.error("❌ AGODA_ERROR_RESPONSE =", text)
    const e: any = new Error(`Agoda API failed: ${res.status} ${text}`)
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

function getDefaultDates() {
  const now = new Date()
  const in1 = new Date(now.getTime() + 24 * 60 * 60 * 1000)
  const in2 = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000)
  return { checkInDate: toYMD(in1), checkOutDate: toYMD(in2) }
}

function toYMD(d: Date) {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, "0")
  const day = String(d.getUTCDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

function normalizeHotel(raw: any) {
  return {
    name: raw?.name ?? raw?.hotelName ?? "Hotel",
    address: raw?.address ?? raw?.hotelAddress ?? "",
    description: raw?.description ?? raw?.hotelDescription ?? "",
    reviewScore: raw?.reviewScore ?? raw?.review_score ?? raw?.rating ?? "",
    imageURL: raw?.imageURL ?? raw?.imageUrl ?? raw?.image ?? raw?.thumbnailUrl ?? ""
  }
}

function generateAffiliateUrl(hotelId: string) {
  const siteId = process.env.AGODA_SITE_ID
  if (!siteId) throw new Error("Missing env: AGODA_SITE_ID")
  return `https://www.agoda.com/partners/partnersearch.aspx?hid=${encodeURIComponent(
    hotelId
  )}&cid=${encodeURIComponent(siteId)}`
}

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
         <img src="${escapeHtmlAttr(hotel.imageURL)}" alt="${escapeHtmlAttr(hotel.name)}"
              style="max-width:100%;border-radius:12px;" />
       </div>`
    : ""

  const ctaHtml = `
  <div style="margin:28px 0;text-align:center;">
    <a href="${escapeHtmlAttr(affiliateUrl)}" target="_blank" rel="nofollow noopener"
       style="background:#ff5a5f;color:#fff;padding:14px 22px;border-radius:10px;text-decoration:none;font-weight:bold;display:inline-block;">
       👉 아고다 최저가 확인하기
    </a>
  </div>`

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
</script>`.trim()

  const intro = `
  <h2>${escapeHtml(keyword)} 추천 호텔: ${escapeHtml(hotel.name)}</h2>
  <p>${escapeHtml(hotel.description || `${hotel.name}의 예약 정보를 정리했어요.`)}</p>`

  const body =
    version === "V2"
      ? `<h3>예약 팁</h3><p>성수기에는 가격 변동이 크니 자주 확인하세요.</p>`
      : version === "V3"
      ? `<h3>체크리스트</h3><ol><li>취소/환불</li><li>교통</li><li>후기</li></ol>`
      : version === "V4"
      ? `<h3>요약</h3><p>아래 버튼에서 바로 가격 확인 가능해요.</p>`
      : `<h3>한 줄 결론</h3><p>${escapeHtml(hotel.name)}은(는) 후보로 볼 만합니다.</p>`

  return `${imageHtml}${intro}${body}${ctaHtml}${faqSchema}`
}

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
    headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
    body: JSON.stringify({ title, content, status, categories: [Number(category)] })
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