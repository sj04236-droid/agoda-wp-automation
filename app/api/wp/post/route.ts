import { NextRequest, NextResponse } from "next/server"

type Version = "V1" | "V2" | "V3"

interface RequestBody {
  keyword: string
  hotelId: string
  publishType?: "draft" | "publish"
  version?: Version
  category?: number
}

const WP_URL = process.env.WP_URL!
const WP_USER = process.env.WP_USERNAME!
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD!
const API_KEY = process.env.API_KEY!

/* ===============================
   🔹 Agoda 이미지 3장 생성 (안전)
================================ */
function buildAgodaImages(hotelId: string) {
  const base = `https://pix8.agoda.net/hotelImages/${hotelId}/-1`
  const fallback =
    "https://images.unsplash.com/photo-1501117716987-c8e1ecb2102a?q=80&w=1200"

  return {
    hero: `${base}/default.jpg?ce=0&s=1200x800`,
    room: `${base}/default.jpg?ce=0&s=1200x800`,
    facility: `${base}/default.jpg?ce=0&s=1200x800`,
    fallback,
  }
}

/* ===============================
   🔹 V1 (짧은 버전)
================================ */
function buildHtmlV1(params: {
  hotelName: string
  keyword: string
  affiliateUrl: string
}) {
  return `
<h1>${params.keyword} 추천 숙소</h1>
<p>${params.hotelName} 예약 전 핵심만 빠르게 정리했습니다.</p>

<div style="margin:20px 0;text-align:center;">
  <a href="${params.affiliateUrl}" target="_blank" rel="nofollow noopener"
     style="background:#ff5a5f;color:#fff;padding:14px 22px;border-radius:12px;text-decoration:none;font-weight:800;">
    👉 아고다 최저가 확인
  </a>
</div>
`
}

/* ===============================
   🔹 V3 (2000자 이상 장문 고정)
================================ */
function buildHtmlV3(params: {
  hotelName: string
  keyword: string
  affiliateUrl: string
  hotelId: string
}) {
  const images = buildAgodaImages(params.hotelId)

  return `
<h1>${params.keyword} 완벽 가이드 | ${params.hotelName}</h1>

<div style="text-align:center;margin:20px 0;">
  <img src="${images.hero}" onerror="this.src='${images.fallback}'"
       style="max-width:100%;border-radius:14px;" />
</div>

<p>${params.keyword}로 검색하는 분들이 가장 많이 궁금해하는 것은
“가격 대비 실제 만족도”입니다. 이 글은 단순 홍보가 아니라
실제 투숙자 리뷰에서 반복적으로 언급되는 포인트를 중심으로
객실·조식·수영장·위치·가격 전략까지 종합적으로 정리한 정보형 리뷰입니다.</p>

<h2>1️⃣ 객실 분석 (실제 체감 기준)</h2>
<p>대형 리조트의 경우 객실 타입과 동(건물)에 따라 체감이 크게 달라집니다.
특히 오션뷰/가든뷰 차이는 가격뿐 아니라 만족도에도 직접적인 영향을 줍니다.
후기에서 자주 언급되는 항목은 침구 컨디션, 수압, 에어컨 소음,
욕실 청결도입니다. 같은 호텔이라도 리노베이션 여부에 따라
차이가 있을 수 있으므로 최근 후기 위주로 확인하는 것이 좋습니다.</p>

<div style="text-align:center;margin:20px 0;">
  <img src="${images.room}" onerror="this.src='${images.fallback}'"
       style="max-width:100%;border-radius:14px;" />
</div>

<h2>2️⃣ 조식 & 수영장 실제 평가</h2>
<p>조식은 성수기와 비수기에 체감 차이가 큽니다.
특히 8~9시는 가장 혼잡한 시간대로 대기 발생 가능성이 있습니다.
수영장은 규모가 크더라도 운영시간과 타월 제공 여부,
키즈존 분리 여부를 반드시 확인해야 합니다.
가족 여행이라면 키즈 동선이 편리한지,
커플 여행이라면 성인 전용 구역이 있는지 체크하는 것이 중요합니다.</p>

<div style="text-align:center;margin:20px 0;">
  <img src="${images.facility}" onerror="this.src='${images.fallback}'"
       style="max-width:100%;border-radius:14px;" />
</div>

<h2>3️⃣ 위치 & 이동 동선</h2>
<p>공항 또는 주요 관광지까지 이동 시간이 만족도를 좌우합니다.
셔틀 운영 여부, 택시 평균 요금, 주변 편의시설 접근성을
확인하면 여행 스트레스를 줄일 수 있습니다.
리조트형 숙소는 내부 시설이 잘 갖춰져 있어
숙소 중심 휴양 일정에 특히 적합합니다.</p>

<h2>4️⃣ 가격 전략</h2>
<p>가격은 날짜에 따라 크게 변동됩니다.
체크인 날짜를 1~2일 이동하며 비교하면
의외로 큰 차이를 발견할 수 있습니다.
또한 무료취소 조건과 총액(세금 포함)을 기준으로
비교하는 것이 가장 안전합니다.</p>

<div style="margin:25px 0;text-align:center;">
  <a href="${params.affiliateUrl}" target="_blank" rel="nofollow noopener"
     style="background:#007bff;color:#fff;padding:14px 24px;border-radius:12px;font-weight:900;text-decoration:none;">
    🏨 객실 옵션 및 총액 확인
  </a>
</div>

<h2>5️⃣ 이런 여행자에게 추천</h2>
<ul>
<li>가족 여행 – 키즈 동선 & 부대시설 활용도 중요</li>
<li>커플/허니문 – 전망과 분위기 중시</li>
<li>휴양 중심 일정 – 숙소에서 대부분 해결하고 싶은 경우</li>
</ul>

<h2>FAQ</h2>
<p><strong>Q. 조식 포함이 유리할까요?</strong><br/>
총액 기준으로 비교하는 것이 정답입니다.</p>

<p><strong>Q. 사진과 실제가 다를 수 있나요?</strong><br/>
가능합니다. 최근 리뷰 위주로 확인하세요.</p>

<div style="margin:25px 0;text-align:center;">
  <a href="${params.affiliateUrl}" target="_blank" rel="nofollow noopener"
     style="background:#28a745;color:#fff;padding:14px 24px;border-radius:12px;font-weight:900;text-decoration:none;">
    📅 예약 페이지 바로가기
  </a>
</div>
`
}

/* ===============================
   🔹 버전 분기
================================ */
function buildHtmlByVersion(params: {
  version: Version
  hotelName: string
  keyword: string
  affiliateUrl: string
  hotelId: string
}) {
  const { version, ...rest } = params
  if (version === "V1") return buildHtmlV1(rest)
  return buildHtmlV3(rest)
}

/* ===============================
   🔹 POST API
================================ */
export async function POST(req: NextRequest) {
  const apiKey = req.headers.get("x-api-key")
  if (apiKey !== API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const body: RequestBody = await req.json()

  const keyword = body.keyword
  const hotelId = body.hotelId
  const version = body.version || "V3"
  const category = body.category || 1

  const finalStatus =
    body.publishType === "publish" ? "publish" : "draft"

  const affiliateUrl = `https://www.agoda.com/partners/partnersearch.aspx?hid=${hotelId}&cid=1959499&hl=ko-kr&rooms=1&adults=2`

  const hotelName = keyword

  const content = buildHtmlByVersion({
    version,
    hotelName,
    keyword,
    affiliateUrl,
    hotelId,
  })

  const wpRes = await fetch(`${WP_URL}/wp-json/wp/v2/posts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization:
        "Basic " +
        Buffer.from(`${WP_USER}:${WP_APP_PASSWORD}`).toString("base64"),
    },
    body: JSON.stringify({
      title: `${keyword} 완벽 가이드`,
      content,
      status: finalStatus,
      categories: [category],
    }),
  })

  const wpData = await wpRes.json()

  return NextResponse.json({
    success: true,
    resolved: { keyword, hotelId, version, publishType: finalStatus },
    wp: wpData,
  })
}