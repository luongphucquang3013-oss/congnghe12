import mammoth from 'mammoth';
import { Question } from '../types.ts';

// Dọn dẹp khóa API cũ nếu từng được lưu cục bộ trên trình duyệt
try {
  localStorage.removeItem('VITE_GEMINI_API_KEY');
  localStorage.removeItem('GEMINI_API_KEY');
} catch {}

export interface GenerateExamParams {
  theoryText: string;
  examTitle?: string;
  subject?: string;
  grade?: string;
  mcCount?: number;
  tfCount?: number;
}

export interface ExamGenerationResult {
  title: string;
  description?: string;
  subject?: string;
  grade?: string;
  durationMinutes?: number;
  questions: Question[];
}

/**
 * Chuẩn hóa danh sách câu hỏi:
 * - Trắc nghiệm 4 lựa chọn đặt trước (Phần I)
 * - 4 câu Đúng/Sai LUÔN LUÔN Ở CUỐI (Phần II)
 * - Các phương án lựa chọn giữ đúng 100% trật tự A, B, C, D
 */
export function normalizeExamQuestions(rawQuestions: any[]): Question[] {
  const orderMap: Record<string, number> = { A: 1, B: 2, C: 3, D: 4, a: 1, b: 2, c: 3, d: 4 };

  const mapped = rawQuestions.map((q: any, i: number) => {
    const normalized: Question = {
      ...q,
      id: q.id || `q_${Date.now()}_${i + 1}`,
    };
    if (normalized.type === 'multiple_choice' && normalized.options && Array.isArray(normalized.options)) {
      const sortedOpts = [...normalized.options].sort((a, b) => {
        const rankA = orderMap[String(a.id || '').toUpperCase()] || 99;
        const rankB = orderMap[String(b.id || '').toUpperCase()] || 99;
        return rankA - rankB;
      });
      normalized.options = sortedOpts;
    }
    return normalized;
  });

  const mc = mapped.filter((q) => q.type === 'multiple_choice');
  const tf = mapped.filter((q) => q.type === 'true_false');
  const others = mapped.filter((q) => q.type !== 'multiple_choice' && q.type !== 'true_false');

  return [...mc, ...others, ...tf];
}

const DEFAULT_REMOTE_API_BASE = 'https://meonghiendien.onrender.com';

function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function buildApiUrl(endpointPath: string): string {
  const isSameOriginServerHost =
    typeof window !== 'undefined' &&
    (window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1' ||
      window.location.hostname.endsWith('.run.app') ||
      window.location.hostname.endsWith('.onrender.com'));

  if (isSameOriginServerHost) {
    const appBase = (import.meta.env.BASE_URL || '/').trim().replace(/\/+$/, '');
    return `${appBase}${endpointPath}`;
  }

  const configuredBase = (import.meta.env.VITE_API_BASE_URL || '').trim().replace(/\/+$/, '');
  if (configuredBase && isValidHttpUrl(configuredBase)) {
    return `${configuredBase}${endpointPath}`;
  }

  if (typeof window !== 'undefined' && window.location.hostname.endsWith('.github.io')) {
    return `${DEFAULT_REMOTE_API_BASE}${endpointPath}`;
  }

  const appBase = (import.meta.env.BASE_URL || '/').trim().replace(/\/+$/, '');
  return `${appBase}${endpointPath}`;
}

async function postJson<T>(endpointPath: string, body: unknown): Promise<T> {
  const url = buildApiUrl(endpointPath);
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(
      `Không thể kết nối tới máy chủ AI (${url}). Nếu máy chủ Render đang ở trạng thái ngủ (Free tier), vui lòng đợi 20–30 giây để máy chủ khởi động lại rồi thử lại.`
    );
  }

  const text = await response.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error(
        data?.error ||
          'Máy chủ chưa có khóa GEMINI_API_KEY hợp lệ. Hãy cấu hình GEMINI_API_KEY trong Settings > Secrets (AI Studio) hoặc Environment Variables (Render).'
      );
    }
    if (response.status === 403) {
      throw new Error(
        data?.error ||
          'Dự án Google Cloud gắn với GEMINI_API_KEY hiện tại chưa hỗ trợ gói miễn phí (Free Tier) hoặc chưa bật thanh toán (Billing). Vui lòng chọn một API Key đã bật Billing trong AI Studio.'
      );
    }
    if (response.status === 405) {
      const origin = typeof window !== 'undefined' ? window.location.origin : '';
      throw new Error(
        `Máy chủ tại ${origin || 'địa chỉ hiện tại'} không hỗ trợ xử lý yêu cầu AI (HTTP 405). GitHub Pages (*.github.io) và các host tĩnh chỉ phục vụ file HTML/JS nên không thể tự chạy server.ts. Để dùng AI, hãy chạy bằng máy chủ Node.js (npm start / node server.ts trên AI Studio, Render, Railway...) hoặc cấu hình biến VITE_API_BASE_URL trỏ tới địa chỉ máy chủ backend đang chạy.`
      );
    }
    if (response.status === 502 || response.status === 503 || response.status === 504) {
      throw new Error(
        data?.error ||
          `Máy chủ AI (${url}) đang khởi động hoặc tạm thời quá tải (HTTP ${response.status}). Vui lòng đợi 20–30 giây rồi thử lại.`
      );
    }
    const msg =
      data?.error ||
      `Lỗi kết nối máy chủ AI (HTTP ${response.status}). Vui lòng thử lại.`;
    throw new Error(msg);
  }

  if (!data) {
    throw new Error('Máy chủ AI không trả về dữ liệu hợp lệ.');
  }

  return data as T;
}

/**
 * Sinh đề thi trắc nghiệm từ văn bản lý thuyết thông qua API máy chủ (/api/gemini/generate-from-theory)
 */
export async function generateExamFromTheory(
  params: GenerateExamParams
): Promise<ExamGenerationResult> {
  const {
    theoryText,
    examTitle = 'Đề ôn thi Công Nghệ Công Nghiệp',
    subject = 'Công Nghệ Công Nghiệp',
    grade = '12',
    mcCount = 8,
    tfCount = 2,
  } = params;

  if (!theoryText || theoryText.trim().length < 10) {
    throw new Error('Vui lòng cung cấp nội dung lý thuyết hoặc tài liệu tối thiểu 10 ký tự.');
  }

  const parsed = await postJson<ExamGenerationResult>('/api/gemini/generate-from-theory', {
    theoryText,
    examTitle,
    subject,
    grade,
    mcCount,
    tfCount,
  });

  if (parsed.questions && Array.isArray(parsed.questions)) {
    parsed.questions = normalizeExamQuestions(parsed.questions);
  }

  return parsed;
}

/**
 * Trích xuất đề thi từ file Word (.docx, .doc), PDF hoặc TXT thông qua API máy chủ (/api/gemini/extract-from-file)
 */
export async function extractExamFromFile(
  file: File,
  options: {
    mode?: 'extract_exam' | 'generate_from_theory';
    subject?: string;
    grade?: string;
    examTitle?: string;
  } = {}
): Promise<ExamGenerationResult> {
  const {
    mode = 'extract_exam',
    subject = 'Công Nghệ Công Nghiệp',
    grade = '12',
    examTitle = '',
  } = options;

  const fileName = file.name;
  const lowerFileName = fileName.toLowerCase();
  const isPdf = lowerFileName.endsWith('.pdf') || file.type.includes('pdf');
  const isDocx =
    lowerFileName.endsWith('.docx') ||
    lowerFileName.endsWith('.doc') ||
    file.type.includes('word') ||
    file.type.includes('officedocument');

  let base64Data = '';
  let extractedText = '';
  let mimeType = file.type || 'text/plain';

  if (isPdf) {
    mimeType = 'application/pdf';
    base64Data = await fileToBase64(file);
  } else {
    mimeType = 'text/plain';
    if (isDocx) {
      try {
        const arrayBuffer = await file.arrayBuffer();
        const mammothResult = await mammoth.extractRawText({ arrayBuffer } as any);
        extractedText = mammothResult.value || '';
      } catch (mErr) {
        console.warn('Mammoth extraction failed, fallback to file text:', mErr);
        extractedText = await file.text().catch(() => '');
      }
    } else {
      extractedText = await file.text().catch(() => '');
    }

    if (!extractedText.trim()) {
      extractedText = `File tài liệu đề thi: ${fileName}`;
    }
  }

  const parsed = await postJson<ExamGenerationResult>('/api/gemini/extract-from-file', {
    fileName,
    mimeType,
    extractedText,
    base64Data,
    mode,
    subject,
    grade,
    examTitle,
  });

  if (parsed.questions && Array.isArray(parsed.questions)) {
    parsed.questions = normalizeExamQuestions(parsed.questions);
  }

  return parsed;
}

// Convert File to raw base64 string
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.includes(',') ? result.split(',')[1] : result;
      resolve(base64);
    };
    reader.onerror = (error) => reject(error);
    reader.readAsDataURL(file);
  });
}
