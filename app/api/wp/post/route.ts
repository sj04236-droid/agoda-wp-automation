import { NextRequest, NextResponse } from "next/server"

/**
 * ✅ 보안/환경변수
API_KEY (또는 INTERNAL_API_KEY) : tjsrudtjsskatjswn  요청 헤더 x-api-key 검증 
* - WP_URL : https://hotel.lineuplounge.co.kr 
* - WP_USERNAME : java0078
* - WP_APP_PASSWORD : "WYUe avRT tSyd yjaw 6tfu v4G0"
* - AGODA_AFFILIATE_CID : 아고다 제휴 CID (예: 1959499) // 없으면 기본값 사용(1959499) */

type Version = "V1" | "V2" | "V3"
type PublishType = "draft" | "publish"

function safeStr(v: any) {
  return typeof v === "string" ? v : ""
}

const FALLBACK_IMAGE =
  "https://picsum.photos/seed/hotel-placeholder/1200/800"

/**
 * 이미지 URL이 실제로 접근 가능한지 최소 비용으로 확인합니다.
 * - HEAD를 막는 서버가 있어 GET + Range 시도
 * - 이미지가 아니거나 4xx면 null
 */
async function validateImage(url?: string): Promise<string | null> {
  if (!url) return null
  const u = url.trim()
  if (!u) return null

  try {
    // 1) HEAD 시도
    const head = await fetch(u, { method: "HEAD", redirect: "follow" })
    if (head.ok) return u
  } catch {}

  try {
    // 2) GET + Range(0-0) 시도 (대부분의 CDN에서 최소 응답)
    const get = await fetch(u, {
      method: "GET",
      redirect: "follow",
      headers: { Range: "bytes=0-0" },
    })
    if (!get.ok) return null

    const ct = get.headers.get("content-type") || ""
    if (ct.includes("image/")) return u
    // content-type이 없을 수도 있으니 ok면 허용
    return u
  } catch {
    return null
  }
}

function json(res: any, status = 200) {
  return NextResponse.json(res, { status })
}

function unauthorized() {
  return json({ error: "Unauthorized" }, 401)
}

function badRequest(msg: string) {
  return json({ error: msg }, 400)
}

function getInternalApiKey() {
return (
  process.env.API_KEY ||
  process.env.INTERNAL_API_KEY ||
  ""
)

/**
 * ✅ Agoda Affiliate Lookup (lt_v1)
 * - 실제 사용 중인 API 형태 유지
 */
async function agodaGetHotelById(hotelId: string) {
  const url =
    "https://affiliateapi7643.agoda.com/affiliateservice/lt_v1"

  const body = {
    criteria: {
      propertyId: Number(hotelId),
      language: "ko-kr",
      currency: "KRW",
    },
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  })

  const data = await res.json()
  return data
}

/**
 * ✅ WP 글 발행
 */
async function wpCreatePost(params: {
  title: string
  content: string
  status: PublishType
  category?: number
  tags?: number[]
}) {
  const WP_URL = safeStr(process.env.WP_URL)
  const WP_USERNAME = safeStr(process.env.WP_USERNAME)
  const WP_PASSWORD = safeStr(process.env.WP_PASSWORD)

  if (!WP_URL) throw new Error("WP_URL env missing")
  if (!WP_USERNAME) throw new Error("WP_USERNAME env missing")
  if (!WP_PASSWORD) throw new Error("WP_PASSWORD env missing")

  const token = Buffer.from(`${WP_USERNAME}:${WP_PASSWORD}`).toString("base64")

  const postRes = await fetch(`${WP_URL}/wp-json/wp/v2/posts`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      title: params.title,
      content: params.content,
      status: params.status,
      categories: params.category ? [params.category] : undefined,
      tags: params.tags && params.tags.length > 0 ? params.tags : undefined,
    }),
  })

  const wp = await postRes.json()
  return wp
}

/**
 * ✅ HTML 생성 (동기 함수 유지)
 * - await 금지(빌드 에러 방지)
 * - 이미지 검증/대체는 POST 핸들러에서 완료하고 여기엔 "확정 URL"만 넘김
 */
function buildHtml({
  hotelName,
  imageURL,
  imageUrls = [],
  reviewScore,
  affiliateUrl,
  keyword,
  cityName,
  countryName,
}: {
  hotelName: string
  imageURL?: string
  imageUrls?: string[]
  reviewScore?: number
  affiliateUrl: string
  keyword: string
  cityName?: string
  countryName?: string
}) {
  const title = `${keyword} 완벽 가이드: ${hotelName} (객실·조식·수영장·예약팁)`
  const scoreText =
    typeof reviewScore === "number" ? reviewScore.toFixed(1) : "예약 페이지에서 확인"

  const hero = imageURL
    ? `
<div style="text-align:center;margin:20px 0;">
  <img src="${imageURL}" alt="${hotelName} 대표 이미지" style="max-width:100%;border-radius:14px;" />
</div>
`
    : ""

  const gallery = (imageUrls || []).slice(0, 4)
  const galleryHtml =
    gallery.length > 0
      ? `
<h2>📸 사진으로 꼭 확인할 포인트</h2>
<p>호텔은 “사진에서 기대한 느낌”이 중요해요. 최소 <b>전경/로비</b>, <b>객실</b>, <b>수영장</b>, <b>조식</b> 컷 3~4장은 보고 결정하는 걸 추천합니다.</p>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:18px 0;">
  ${gallery
    .map(
      (u, i) =>
        `<img src="${u}" alt="${hotelName} 이미지 ${i + 1}" style="width:100%;border-radius:14px;" />`
    )
    .join("")}
</div>
`
      : ""

  const locationText = [cityName, countryName].filter(Boolean).join(", ") || "예약 페이지에서 확인"

  const html = `
<h1>${keyword} 숙소 고민 끝, ${hotelName} 핵심 정리</h1>
<p>${keyword}로 검색하는 분들이 가장 많이 궁금해하는 건 “가격 대비 실제 만족도”예요.
이 글은 <b>객실·조식·수영장·동선·추가요금</b> 관점에서 선택 기준을 한 번에 정리한 정보형 리뷰 가이드입니다.</p>

${hero}

<div style="margin:18px 0;text-align:center;">
  <a href="${affiliateUrl}" target="_blank" rel="nofollow noopener"
     style="background:#ff5a5f;color:#fff;padding:14px 22px;border-radius:12px;text-decoration:none;font-weight:900;display:inline-block;">
    👉 아고다 최저가 확인하기
  </a>
</div>

<div style="border:1px solid #e5e7eb;border-radius:14px;padding:14px 16px;background:#f8fafc;margin:18px 0;">
  <div style="font-weight:900;font-size:16px;margin-bottom:10px;">🏨 기본 정보 한눈에</div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:14px;line-height:1.55;">
    <div><b>호텔명</b><br/>${hotelName}</div>
    <div><b>핵심 키워드</b><br/>${keyword}</div>
    <div><b>위치</b><br/>${locationText}</div>
    <div><b>평점</b><br/>${scoreText}</div>
    <div><b>비교 기준</b><br/>총액(세금/봉사료) + 무료취소</div>
    <div><b>전환 팁</b><br/>체크인 1~2일만 바꿔 비교</div>
  </div>
  <div style="margin-top:10px;color:#374151;font-size:13px;">
    “좋다/나쁘다”보다 <b>내 여행 타입에 맞는지</b>가 핵심이에요. 아래 체크리스트대로만 보면 실패 확률이 확 줄어요.
  </div>
</div>

${galleryHtml}

<h2>1️⃣ 객실 구성: 같은 호텔인데 만족도가 갈리는 이유</h2>
<p>대형 호텔/리조트는 객실 타입과 동(건물), 층, 전망에 따라 체감이 달라요.
오션뷰는 ‘뷰값’이 있지만, 실제로는 <b>소음/동선/햇빛 방향</b> 때문에 가든뷰가 더 편한 경우도 있어요.
예약 전에 “내가 진짜 원하는 것”을 먼저 정하는 게 중요합니다.</p>
<ul style="margin:10px 0 0 18px;">
  <li style="margin:7px 0;">커플/허니문: 전망 + 프라이버시 우선</li>
  <li style="margin:7px 0;">가족여행: 침대/인원정책 + 키즈 동선 우선</li>
  <li style="margin:7px 0;">부모님 동반: 이동거리(로비/조식당) + 엘리베이터 우선</li>
</ul>

<h2>2️⃣ 조식·수영장·부대시설: “있다”보다 “운영 조건”이 중요</h2>
<p>후기에서 자주 나오는 변수는 운영시간/혼잡도/예약제/유료 여부예요.
특히 조식은 성수기에는 줄이 생길 수 있어 <b>7시대~8시 초반</b>이 체감 만족도가 높은 편입니다.
수영장은 규모도 중요하지만 <b>키즈존 분리</b>, <b>타월 제공</b>, <b>운영시간</b>이 더 중요할 때가 많아요.</p>
<ul style="margin:10px 0 0 18px;">
  <li style="margin:7px 0;">조식 포함/불포함: “1박 차이”가 아니라 <b>총액</b>으로 비교</li>
  <li style="margin:7px 0;">수영장: 키즈풀/성인풀 분리 + 타월 제공 여부 체크</li>
  <li style="margin:7px 0;">셔틀/스파/키즈클럽: 유료/사전예약 여부 확인</li>
</ul>

<h2>3️⃣ 가격 비교는 이렇게 하면 손해를 줄인다</h2>
<p>성수기에는 하루 차이로 금액이 크게 달라질 수 있어요.
또한 같은 가격이라도 “무료취소” 조건이 있으면 심리적 안정감이 커서, 결과적으로 더 좋은 선택이 되기도 합니다.</p>
<ul style="margin:10px 0 0 18px;">
  <li style="margin:7px 0;">체크인 날짜를 1~2일 바꿔가며 총액 비교</li>
  <li style="margin:7px 0;">무료취소 마감일(몇 시까지인지) 확인</li>
  <li style="margin:7px 0;">세금/봉사료 포함 여부를 반드시 총액으로 비교</li>
</ul>

<div style="margin:18px 0;text-align:center;">
  <a href="${affiliateUrl}" target="_blank" rel="nofollow noopener"
     style="background:#007bff;color:#fff;padding:14px 22px;border-radius:12px;text-decoration:none;font-weight:900;display:inline-block;">
    🏨 객실 옵션/총액 비교하기
  </a>
</div>

<h2>4️⃣ 이런 여행자에게 추천</h2>
<ul style="margin:10px 0 0 18px;">
  <li style="margin:7px 0;">가족 여행: 키즈 동선 + 부대시설 활용도가 높은 경우</li>
  <li style="margin:7px 0;">커플/허니문: 전망/분위기/프라이버시를 중시하는 경우</li>
  <li style="margin:7px 0;">휴양 중심: 숙소에서 대부분 해결하고 싶은 일정</li>
</ul>

<h2>5️⃣ 예약 전 체크리스트(최종)</h2>
<ul style="margin:10px 0 0 18px;">
  <li style="margin:7px 0;">무료취소 마감일과 수수료 규정</li>
  <li style="margin:7px 0;">조식 포함 여부 + 총액(세금/봉사료 포함)</li>
  <li style="margin:7px 0;">객실 타입(전망/침대/인원)과 추가요금</li>
  <li style="margin:7px 0;">이동 동선(공항/핵심 스팟)과 교통비</li>
</ul>

<div style="margin:18px 0;text-align:center;">
  <a href="${affiliateUrl}" target="_blank" rel="nofollow noopener"
     style="background:#28a745;color:#fff;padding:14px 22px;border-radius:12px;text-decoration:none;font-weight:900;display:inline-block;">
    📅 예약 페이지 바로가기
  </a>
</div>

<h2>자주 묻는 질문(FAQ)</h2>
<p><b>Q. 조식 포함 옵션이 유리한가요?</b><br/>A. 총액 기준으로 비교하는 게 정답이에요. 1박당 조식 차액이 크지 않다면 포함 옵션이 편한 경우가 많습니다.</p>
<p><b>Q. 사진과 실제 컨디션이 다를 수 있나요?</b><br/>A. 가능해요. 최근 후기에서 침구/냄새/수압/에어컨 같은 반복 키워드가 어떻게 언급되는지 확인하면 실패 확률을 줄일 수 있어요.</p>

<h2>🏷 해시태그</h2>
<p>#${keyword.replace(/\\s+/g, "")} #숙소추천 #아고다 #호텔예약 #여행팁</p>
`
  return { title, html }
}

export async function POST(req: NextRequest) {
  try {

    // ✅ 내부 API키 체크
    const headerKey = safeStr(req.headers.get("x-api-key"))
    const internalKey = getInternalApiKey()
    if (!internalKey || headerKey !== internalKey) return unauthorized()

    let body: any = {}
    try {
      body = await req.json()
    } catch {
      return badRequest("Invalid JSON body")
    }

    // 🔽 기존 POST 내부 나머지 코드 전부 그대로 여기 둔다

  } catch (e: any) {
    console.error("API ERROR:", e)
    return NextResponse.json(
      { error: e?.message || String(e) },
      { status: 500 }
    )
  }
}

  const keyword = safeStr(body.keyword)
  const hotelId = safeStr(body.hotelId)
  const version = (safeStr(body.version) as Version) || "V3"
  const publishType = (safeStr(body.publishType) as PublishType) || "draft"
  const category = typeof body.category === "number" ? body.category : undefined

  if (!keyword) return badRequest("keyword is required")
  if (!hotelId) return badRequest("hotelId is required")
  if (!["V1", "V2", "V3"].includes(version)) return badRequest("version must be V1|V2|V3")
  if (!["draft", "publish"].includes(publishType)) return badRequest("publishType must be draft|publish")

  // ✅ 아고다 데이터 조회
  const agodaData = await agodaGetHotelById(hotelId)

  // ✅ 응답에서 첫 번째 호텔 객체를 최대한 관대하게 추출
  const first =
    (agodaData && agodaData.results && Array.isArray(agodaData.results) && agodaData.results[0]) ||
    (agodaData && agodaData.data && Array.isArray(agodaData.data) && agodaData.data[0]) ||
    (agodaData && agodaData.result && Array.isArray(agodaData.result) && agodaData.result[0]) ||
    agodaData

  const hotelName = first.hotelName || first.propertyName || `Hotel ${hotelId}`
  const reviewScore = typeof first.reviewScore === "number" ? first.reviewScore : undefined

  // ✅ 이미지: hero 1장 + (가능하면) 갤러리 3~4장
  const rawHero = safeStr((first as any).imageURL) || ""
  const rawGallery =
    (first as any).imageUrls ||
    (first as any).imageURLS ||
    (first as any).images ||
    (first as any).hotelImages ||
    []

  const galleryCandidates: string[] = Array.isArray(rawGallery)
    ? rawGallery.map((x: any) => safeStr(x)).filter(Boolean)
    : []

const heroImage = (await validateImage(rawHero)) || FALLBACK_IMAGE

  const validGallery = (
    await Promise.all(galleryCandidates.slice(0, 4).map((u) => validateImage(u)))
  ).filter(Boolean) as string[]

  // ✅ 아고다 제휴 링크
  const cid = safeStr(process.env.AGODA_CID) || "1959499"
  const affiliateUrl = `https://www.agoda.com/partners/partnersearch.aspx?hid=${encodeURIComponent(
    hotelId
  )}&cid=${encodeURIComponent(cid)}&hl=ko-kr&rooms=1&adults=2`

  // ✅ HTML 생성 (동기 함수)
  const out = buildHtml({
    hotelName,
imageURL: heroImage,
    imageUrls: validGallery,
    reviewScore,
    affiliateUrl,
    keyword,
    cityName: safeStr((first as any).cityName),
    countryName: safeStr((first as any).countryName),
  })

  // ✅ WP 발행
  const wp = await wpCreatePost({
    title: out.title,
    content: out.html,
    status: publishType,
    category,
  })

  return json({
    success: true,
    resolved: {
      keyword,
      hotelId,
      version,
      publishType,
      affiliateUrl,
      imageURL: validHero,
      imageUrls: validGallery,
    },
    wp,
  })
}