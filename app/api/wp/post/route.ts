import { NextRequest, NextResponse } from "next/server"

/**
 * ✅ 보안/환경변수 (Vercel Environment Variables)
 * - API_KEY (또는 INTERNAL_API_KEY) : 요청 헤더 x-api-key 검증
 * - WP_URL : 예) https://hotel.lineuplounge.co.kr
 * - WP_USERNAME : 워드프레스 계정 (예: java0078)
 * - WP_APP_PASSWORD : 워드프레스 Application Password (예: "xxxx xxxx xxxx xxxx xxxx xxxx")
 *   (호환: WP_PASSWORD 도 지원)
 * - AGODA_AFFILIATE_CID : 아고다 제휴 CID (예: 1959499)  // 없으면 기본값 사용(1959499)
 *
 * ✅ 요청 바디(JSON)
 * {
 *   "keyword": "빈펄 리조트 푸꾸옥",
 *   "hotelId": "625168",
 *   "version": "V3",
 *   "publishType": "draft",
 *   "category": 1
 * }
 */

type Version = "V1" | "V2" | "V3"
type PublishType = "draft" | "publish"

function safeStr(v: any) {
  return typeof v === "string" ? v : ""
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

/**
 * ✅ 내부 API 키 (헤더 x-api-key 검증용)
 */
function getInternalApiKey() {
  return safeStr(process.env.API_KEY) || safeStr(process.env.INTERNAL_API_KEY) || ""
}

/**
 * ✅ Agoda Affiliate Lookup (lt_v1)
 * - 기존 사용 중인 API 형태 유지
 */
async function agodaGetHotelById(hotelId: string) {
  const url = "https://affiliateapi7643.agoda.com/affiliateservice/lt_v1"

  const body = {
    criteria: {
      propertyId: Number(hotelId),
      language: "ko-kr",
      currency: "KRW",
    },
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

  // 응답이 비정상일 때도 에러 메시지 확인 가능하게 처리
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

/**
 * ✅ WP 글 발행
 * - Vercel에는 WP_APP_PASSWORD로 저장했다고 했으므로 그 값을 우선 사용
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
  const WP_PASSWORD = safeStr(process.env.WP_APP_PASSWORD) || safeStr(process.env.WP_PASSWORD)

  if (!WP_URL) throw new Error("WP_URL env missing")
  if (!WP_USERNAME) throw new Error("WP_USERNAME env missing")
  if (!WP_PASSWORD) throw new Error("WP_APP_PASSWORD env missing")

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
 * ✅ HTML 생성 (이미지 제외 버전)
 * - 사용자가 “이미지 제외하고 글쓰기” 요청 → 이미지 블록/갤러리 미포함
 * - 글자수(공백 제외) 2000자 이상을 목표로 섹션을 충분히 길게 구성
 */
function buildHtml(params: {
  hotelName: string
  affiliateUrl: string
  keyword: string
  hotelId: string
  reviewScoreText?: string
  cityName?: string
  countryName?: string
}) {
  const { hotelName, affiliateUrl, keyword, hotelId, reviewScoreText, cityName, countryName } = params

  const locationText = [cityName, countryName].filter(Boolean).join(", ") || "예약 페이지에서 확인"
  const scoreText = reviewScoreText || "예약 페이지에서 확인"

  const title = `${keyword} 완벽 가이드: ${hotelName} (객실·조식·수영장·예약팁)`

  const html = `
<h1>${keyword} 숙소 고민 끝, ${hotelName} 핵심 정리</h1>
<p>${keyword}로 검색하는 분들이 가장 궁금해하는 건 “가격 대비 실제 만족도”예요.
이 글은 <b>리뷰에서 반복적으로 언급되는 포인트</b>를 기준으로 <b>객실·조식·수영장·동선·추가요금</b> 관점에서 선택 기준을 한 번에 정리한 <b>정보형+리뷰형 통합 가이드</b>입니다.</p>

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
    <div><b>호텔 ID</b><br/>${hotelId}</div>
    <div><b>위치</b><br/>${locationText}</div>
    <div><b>평점</b><br/>${scoreText}</div>
    <div><b>비교 기준</b><br/>총액(세금/봉사료) + 무료취소</div>
  </div>
  <div style="margin-top:10px;color:#374151;font-size:13px;">
    “좋다/나쁘다”보다 <b>내 여행 타입에 맞는지</b>가 핵심이에요. 아래 체크리스트대로만 보면 실패 확률이 확 줄어요.
  </div>
</div>

<h2>0️⃣ 결론 먼저: 이 숙소가 잘 맞는 사람</h2>
<ul style="margin:10px 0 0 18px;">
  <li style="margin:7px 0;"><b>리조트 안에서 대부분 해결</b>하고 싶은 휴양 일정</li>
  <li style="margin:7px 0;"><b>가족 여행</b>: 수영장/키즈 동선/조식 편의성이 중요한 경우</li>
  <li style="margin:7px 0;"><b>커플·허니문</b>: 전망, 분위기, 프라이버시를 중시하는 경우</li>
</ul>
<p style="margin-top:10px;">반대로 “무조건 도심 접근성”이 1순위이거나 “잠만 자는 일정”이라면 같은 예산으로 더 가성비 좋은 선택지가 있을 수 있어요.</p>

<h2>1️⃣ 객실 선택: 같은 호텔인데 만족도가 갈리는 이유</h2>
<p>대형 호텔/리조트는 객실 타입과 동(건물), 층, 전망에 따라 체감이 달라요.
오션뷰는 ‘뷰값’이 있지만, 실제로는 <b>소음/동선/햇빛 방향</b> 때문에 가든뷰가 더 편한 경우도 있어요.
예약 전에 “내가 진짜 원하는 것(뷰/조용함/동선/침대/욕조)”을 먼저 정해두면 실패 확률이 확 줄어듭니다.</p>
<ul style="margin:10px 0 0 18px;">
  <li style="margin:7px 0;"><b>가족</b>: 침대 구성(킹/트윈), 아동 동반 정책, 엑스트라베드/소파베드 추가요금 확인</li>
  <li style="margin:7px 0;"><b>커플</b>: 전망(오션/가든) + 프라이버시 + 발코니 여부</li>
  <li style="margin:7px 0;"><b>부모님</b>: 엘리베이터/조식당/로비까지 이동거리(동선) + 소음(도로/로비 인접) 체크</li>
</ul>
<p style="margin-top:10px;">리뷰를 볼 때는 “좋다/나쁘다”보다 <b>침구·냄새·수압·에어컨 소음</b>처럼 반복 언급되는 항목을 체크하는 게 가장 정확합니다.</p>

<h2>2️⃣ 조식·수영장·부대시설: ‘있다’보다 ‘운영 조건’이 핵심</h2>
<p>조식과 수영장은 “시설의 존재”보다 <b>운영시간/혼잡도/예약제/유료 여부</b>가 체감 만족도를 좌우해요.
특히 조식은 성수기엔 줄이 생길 수 있어 <b>7시대~8시 초반</b>에 가면 체감이 좋아지는 편입니다.
수영장은 규모도 중요하지만 <b>키즈존 분리</b>, <b>타월 제공</b>, <b>그늘/선베드 경쟁</b>이 실제 만족도를 크게 바꿉니다.</p>
<ul style="margin:10px 0 0 18px;">
  <li style="margin:7px 0;">조식 포함/불포함은 “1박 차이”가 아니라 <b>총액 기준</b>으로 비교</li>
  <li style="margin:7px 0;">셔틀/스파/키즈클럽은 <b>유료/사전예약</b> 여부 확인</li>
  <li style="margin:7px 0;">성수기에는 체크인/조식 혼잡이 생길 수 있어 <b>체크인 시간 분산</b>이 유리</li>
</ul>

<h2>3️⃣ 가격 비교 전략: 손해 줄이는 5단계</h2>
<ol style="margin:10px 0 0 18px;line-height:1.8;">
  <li><b>체크인 날짜를 1~2일</b> 바꿔가며 총액 비교(성수기 변동 폭 큼)</li>
  <li>무료취소가 가능하다면 <b>마감 “날짜+시간”</b>까지 확인</li>
  <li>세금/봉사료 포함 여부는 반드시 <b>총액</b>으로 비교</li>
  <li>조식 포함 옵션은 인원수에 따라 유불리가 달라짐(성인 2+아동이면 포함이 유리할 때 많음)</li>
  <li>연박이면 “1박만 바꿔서” 가격이 내려가는 경우도 있어 <b>분할 예약</b>도 고려</li>
</ol>

<div style="margin:18px 0;text-align:center;">
  <a href="${affiliateUrl}" target="_blank" rel="nofollow noopener"
     style="background:#007bff;color:#fff;padding:14px 22px;border-radius:12px;text-decoration:none;font-weight:900;display:inline-block;">
    🏨 객실 옵션/총액 비교하기
  </a>
</div>

<h2>4️⃣ 체크인 전에 알아두면 좋은 ‘실수 방지’ 포인트</h2>
<ul style="margin:10px 0 0 18px;">
  <li style="margin:7px 0;"><b>인원 정책</b>: “성인 2” 기준가가 많아 아동/추가 인원에 요금이 붙을 수 있어요.</li>
  <li style="margin:7px 0;"><b>침대 타입</b>: 트윈/킹은 “요청 사항”일 뿐 보장 아닌 경우가 많습니다.</li>
  <li style="margin:7px 0;"><b>교통비</b>: 공항↔숙소, 숙소↔핵심 스팟 이동비가 누적되면 체감 가격이 달라져요.</li>
  <li style="margin:7px 0;"><b>체크인 대기</b>: 성수기엔 대기 가능 → 여권/예약번호 준비, 체크인 시간 분산 추천.</li>
</ul>

<h2>5️⃣ 마지막 한 줄 결론</h2>
<p>결국 중요한 건 “내 여행 스타일에 맞는 객실/옵션을 고르는 것”입니다.
아래 버튼에서 날짜를 1~2일만 바꿔보며 총액을 비교해보면, 생각보다 더 좋은 조건을 찾을 가능성이 높아요.</p>

<div style="margin:18px 0;text-align:center;">
  <a href="${affiliateUrl}" target="_blank" rel="nofollow noopener"
     style="background:#28a745;color:#fff;padding:14px 22px;border-radius:12px;text-decoration:none;font-weight:900;display:inline-block;">
    📅 예약 페이지 바로가기
  </a>
</div>

<h2>자주 묻는 질문(FAQ)</h2>
<p><b>Q. 조식 포함 옵션이 유리한가요?</b><br/>A. 총액 기준으로 비교하는 게 정답이에요. 1박당 차액이 크지 않다면 포함 옵션이 편한 경우가 많습니다.</p>
<p><b>Q. 사진과 실제 컨디션이 다를 수 있나요?</b><br/>A. 가능해요. 최근 후기에서 <b>침구/냄새/수압/에어컨</b> 같은 반복 키워드가 어떻게 언급되는지 확인하면 실패 확률을 줄일 수 있어요.</p>
<p><b>Q. 무료취소만 보고 잡아도 되나요?</b><br/>A. 무료취소는 안전장치지만, “마감 시간”과 “부분 환불/수수료” 조건이 달라요. 결제 전 정책을 꼭 확인하세요.</p>

<h2>🏷 해시태그</h2>
<p>#${keyword.replace(/\s+/g, "")} #숙소추천 #아고다 #호텔예약 #여행팁 #리조트</p>
`.trim()

  return { title, html }
}

export async function POST(req: NextRequest) {
  try {
    // ✅ 내부 API키 체크
    const headerKey = safeStr(req.headers.get("x-api-key"))
    const internalKey = getInternalApiKey()
    if (!internalKey || headerKey !== internalKey) return unauthorized()

    // ✅ JSON 파싱
    let body: any = {}
    try {
      body = await req.json()
    } catch {
      return badRequest("Invalid JSON body")
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
      (agodaData && (agodaData as any).results && Array.isArray((agodaData as any).results) && (agodaData as any).results[0]) ||
      (agodaData && (agodaData as any).data && Array.isArray((agodaData as any).data) && (agodaData as any).data[0]) ||
      (agodaData && (agodaData as any).result && Array.isArray((agodaData as any).result) && (agodaData as any).result[0]) ||
      agodaData

    const hotelName =
      safeStr((first as any)?.hotelName) ||
      safeStr((first as any)?.propertyName) ||
      `Hotel ${hotelId}`

    const reviewScoreVal =
      typeof (first as any)?.reviewScore === "number" ? (first as any).reviewScore : undefined
    const reviewScoreText =
      typeof reviewScoreVal === "number" ? reviewScoreVal.toFixed(1) : undefined

    // ✅ 아고다 제휴 링크
    const cid =
      safeStr(process.env.AGODA_AFFILIATE_CID) ||
      safeStr(process.env.AGODA_CID) ||
      "1959499"

    const affiliateUrl = `https://www.agoda.com/partners/partnersearch.aspx?hid=${encodeURIComponent(
      hotelId
    )}&cid=${encodeURIComponent(cid)}&hl=ko-kr&rooms=1&adults=2`

    // ✅ HTML 생성 (이미지 제외)
    const out = buildHtml({
      hotelName,
      affiliateUrl,
      keyword,
      hotelId,
      reviewScoreText,
      cityName: safeStr((first as any)?.cityName),
      countryName: safeStr((first as any)?.countryName),
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
      },
      wp,
    })
  } catch (e: any) {
    console.error("API ERROR:", e)
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}