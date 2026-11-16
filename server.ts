import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const GEMINI_MODEL = 'gemini-4-hydrogen';

interface OptionItem {
  id: string;
  text: string;
}

interface RawQuestion {
  id?: string;
  type?: string;
  question?: string;
  options?: OptionItem[];
  [key: string]: unknown;
}

function getGeminiClient(): GoogleGenAI {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    const err = new Error(
      'Máy chủ chưa có biến môi trường GEMINI_API_KEY. Hãy gắn GEMINI_API_KEY trong Settings > Secrets (trên AI Studio) hoặc mục Environment Variables (trên Render).'
    ) as Error & { statusCode?: number; errorCode?: string };
    err.statusCode = 401;
    err.errorCode = 'MISSING_API_KEY';
    throw err;
  }

  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function normalizeExamQuestions(rawQuestions: RawQuestion[]): RawQuestion[] {
  const orderMap: Record<string, number> = {
    A: 1,
    B: 2,
    C: 3,
    D: 4,
    a: 1,
    b: 2,
    c: 3,
    d: 4,
  };

  const mapped = rawQuestions.map((q, i) => {
    const normalized: RawQuestion = {
      ...q,
      id: q.id || `q_${Date.now()}_${i + 1}`,
    };

    if (
      normalized.type === 'multiple_choice' &&
      Array.isArray(normalized.options)
    ) {
      normalized.options = [...normalized.options].sort((a, b) => {
        const rankA = orderMap[String(a.id || '').toUpperCase()] || 99;
        const rankB = orderMap[String(b.id || '').toUpperCase()] || 99;
        return rankA - rankB;
      });
    }
    return normalized;
  });

  const mc = mapped.filter((q) => q.type === 'multiple_choice');
  const tf = mapped.filter((q) => q.type === 'true_false');
  const others = mapped.filter(
    (q) => q.type !== 'multiple_choice' && q.type !== 'true_false'
  );

  return [...mc, ...others, ...tf];
}

function extractErrorDetails(err: unknown): {
  statusCode: number;
  code: string;
  message: string;
} {
  const rawErr = err as {
    statusCode?: number;
    status?: number;
    errorCode?: string;
    message?: string;
  };
  const msg = String(rawErr?.message || '');
  const upperMsg = msg.toUpperCase();

  if (rawErr?.statusCode === 401 || rawErr?.errorCode === 'MISSING_API_KEY') {
    return {
      statusCode: 401,
      code: 'MISSING_API_KEY',
      message: msg,
    };
  }

  if (
    rawErr?.status === 403 ||
    upperMsg.includes('PERMISSION_DENIED') ||
    msg.includes('"code":403') ||
    msg.toLowerCase().includes('free tier is not available')
  ) {
    return {
      statusCode: 403,
      code: 'PERMISSION_DENIED',
      message:
        'Dự án Google Cloud gắn với GEMINI_API_KEY hiện tại chưa hỗ trợ gói miễn phí (Free Tier) hoặc chưa bật thanh toán (Billing). Vui lòng kiểm tra hoặc chọn một API Key đã bật Billing trong mục Settings > Secrets của AI Studio.',
    };
  }

  if (
    rawErr?.status === 400 ||
    upperMsg.includes('API_KEY_INVALID') ||
    msg.toLowerCase().includes('api key not valid')
  ) {
    return {
      statusCode: 400,
      code: 'API_KEY_INVALID',
      message:
        'GEMINI_API_KEY không hợp lệ. Vui lòng kiểm tra lại khóa API trong mục Settings > Secrets của AI Studio.',
    };
  }

  if (
    rawErr?.status === 429 ||
    upperMsg.includes('RESOURCE_EXHAUSTED') ||
    msg.includes('"code":429')
  ) {
    return {
      statusCode: 429,
      code: 'RESOURCE_EXHAUSTED',
      message:
        'Đã vượt quá giới hạn lượt gọi Gemini API (429). Vui lòng đợi một lát rồi thử lại hoặc kiểm tra hạn mức API Key trong mục Settings > Secrets.',
    };
  }

  if (
    rawErr?.status === 404 ||
    upperMsg.includes('NOT_FOUND') ||
    msg.includes('"code":404')
  ) {
    return {
      statusCode: 404,
      code: 'NOT_FOUND',
      message: `Không tìm thấy mô hình AI (${GEMINI_MODEL}) hoặc tài nguyên yêu cầu.`,
    };
  }

  return {
    statusCode: 500,
    code: 'INTERNAL_ERROR',
    message: msg || 'Đã có lỗi xảy ra khi kết nối máy chủ Gemini AI.',
  };
}

async function generateWithRetry(
  aiClient: GoogleGenAI,
  contents: unknown,
  systemInstruction: string
): Promise<string> {
  const maxAttempts = 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await aiClient.models.generateContent({
        model: GEMINI_MODEL,
        contents: contents as never,
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
        },
      });
      return response.text || '';
    } catch (err: unknown) {
      lastError = err;
      const details = extractErrorDetails(err);
      // Do not retry auth/permission/invalid-key errors
      if (
        details.statusCode === 400 ||
        details.statusCode === 401 ||
        details.statusCode === 403 ||
        details.statusCode === 404
      ) {
        throw err;
      }
      if (attempt < maxAttempts) {
        const delayMs = 600 * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  throw lastError;
}

function parseJsonResponse(responseText: string): Record<string, unknown> {
  const cleanJson = responseText
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();

  const parsed = JSON.parse(cleanJson) as Record<string, unknown>;
  if (Array.isArray(parsed.questions)) {
    parsed.questions = normalizeExamQuestions(
      parsed.questions as RawQuestion[]
    );
  }
  return parsed;
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '50mb' }));

  const apiRouter = express.Router();
  apiRouter.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  apiRouter.get('/health', (_req, res) => {
    res.json({ ok: true, model: GEMINI_MODEL });
  });

  apiRouter.post('/gemini/generate-from-theory', async (req, res) => {
    try {
      const {
        theoryText,
        examTitle = 'Đề ôn thi Công Nghệ Công Nghiệp',
        subject = 'Công Nghệ Công Nghiệp',
        grade = '12',
        mcCount = 8,
        tfCount = 2,
      } = req.body || {};

      if (
        !theoryText ||
        typeof theoryText !== 'string' ||
        theoryText.trim().length < 10
      ) {
        res.status(400).json({
          error:
            'Vui lòng cung cấp nội dung lý thuyết hoặc tài liệu tối thiểu 10 ký tự.',
        });
        return;
      }

      const aiClient = getGeminiClient();

      const systemInstruction =
        'Bạn là chuyên gia giáo dục và biên soạn đề thi trắc nghiệm theo chuẩn chương trình GDPT mới nhất của Bộ Giáo dục & Đào tạo Việt Nam. Luôn trả về duy nhất một đối tượng JSON hợp lệ, không kèm văn bản ngoài JSON.';

      const prompt = `Nhiệm vụ: Đọc kỹ tài liệu lý thuyết sau đây và biên soạn một bộ đề thi trắc nghiệm chất lượng cao gồm:
- ${mcCount} câu hỏi trắc nghiệm 4 lựa chọn (A, B, C, D) đặt ở Phần I (lên trước)
- ${tfCount} câu hỏi trắc nghiệm Đúng/Sai đặt ở Phần II (luôn nằm ở cuối danh sách; mỗi câu có 1 bối cảnh/đoạn trích thông tin chung và đúng 4 nhận định a, b, c, d với đáp án Đúng hoặc Sai)

Môn học: ${subject}
Khối lớp: ${grade}
Tiêu đề dự kiến: ${examTitle}

Nội dung lý thuyết cung cấp:
"""
${theoryText.slice(0, 20000)}
"""

Yêu cầu BẮT BUỘC về kết quả:
Trả về DUY NHẤT một đối tượng JSON hợp lệ theo cấu trúc sau:
{
  "title": "${examTitle}",
  "description": "Đề thi kiểm tra kiến thức về ${subject}",
  "questions": [
    {
      "id": "q1",
      "type": "multiple_choice",
      "question": "Nội dung câu hỏi trắc nghiệm 4 lựa chọn...",
      "options": [
        {"id": "A", "text": "Lựa chọn A"},
        {"id": "B", "text": "Lựa chọn B"},
        {"id": "C", "text": "Lựa chọn C"},
        {"id": "D", "text": "Lựa chọn D"}
      ],
      "correctAnswer": "A",
      "explanation": "Lời giải thích chi tiết tại sao A đúng và các đáp án khác sai."
    },
    {
      "id": "q2",
      "type": "true_false",
      "context": "Đoạn văn bản bối cảnh hoặc đoạn trích dữ liệu làm cơ sở cho 4 nhận định...",
      "question": "Dựa vào thông tin trên, hãy xác định tính Đúng/Sai của mỗi nhận định sau:",
      "statements": [
        {"id": "a", "text": "Nhận định thứ nhất...", "isCorrect": true, "explanation": "Giải thích chi tiết nhận định a..."},
        {"id": "b", "text": "Nhận định thứ hai...", "isCorrect": false, "explanation": "Giải thích chi tiết nhận định b..."},
        {"id": "c", "text": "Nhận định thứ ba...", "isCorrect": true, "explanation": "Giải thích chi tiết nhận định c..."},
        {"id": "d", "text": "Nhận định thứ tư...", "isCorrect": false, "explanation": "Giải thích chi tiết nhận định d..."}
      ]
    }
  ]
}`;

      const responseText = await generateWithRetry(
        aiClient,
        prompt,
        systemInstruction
      );

      try {
        const parsed = parseJsonResponse(responseText);
        res.json(parsed);
      } catch (parseErr) {
        console.error('JSON Parse error from Gemini generate:', parseErr);
        res.status(502).json({
          error:
            'Dữ liệu từ Gemini AI không đọc được dưới dạng JSON chuẩn. Vui lòng thử lại.',
        });
      }
    } catch (err: unknown) {
      console.error('Server Gemini generate-from-theory error:', err);
      const details = extractErrorDetails(err);
      res
        .status(details.statusCode)
        .json({ error: details.message, code: details.code });
    }
  });

  apiRouter.post('/gemini/extract-from-file', async (req, res) => {
    try {
      const {
        fileName = 'tailieu',
        mimeType = 'text/plain',
        extractedText = '',
        base64Data = '',
        mode = 'extract_exam',
        subject = 'Công Nghệ Công Nghiệp',
        grade = '12',
        examTitle = '',
      } = req.body || {};

      const aiClient = getGeminiClient();

      const systemInstruction =
        'Bạn là chuyên gia giáo dục và khảo thí hàng đầu tại Việt Nam, am hiểu sâu sắc quy chuẩn đề thi trắc nghiệm theo Chương trình GDPT mới nhất của Bộ Giáo dục & Đào tạo. Luôn trả về duy nhất một chuỗi JSON hợp lệ, không kèm văn bản ngoài JSON.';

      const promptInstructions = `NHIỆM VỤ CỦA BẠN:
Đọc và phân tích file đề thi/tài liệu đính kèm (Tên file: "${fileName}").
Chế độ xử lý: "${mode === 'extract_exam' ? 'BÓC TÁCH VÀ CHUYỂN ĐỔI ĐỀ THI CÓ SẴN' : 'TẠO BỘ ĐỀ THI MỚI TỪ TÀI LIỆU'}".

YÊU CẦU CHI TIẾT:
1. Nhận diện và trích xuất TOÀN BỘ các câu hỏi trắc nghiệm có trong file:
   - Dạng 1: Trắc nghiệm 4 lựa chọn (A, B, C, D) đặt ở Phần I (lên trước)
   - Dạng 2: Trắc nghiệm Đúng / Sai (Gồm 1 đoạn bối cảnh/dữ liệu chung và đúng 4 nhận định a, b, c, d với tính Đúng/Sai) đặt ở Phần II (luôn ở cuối danh sách)
2. Xác định Đáp án chuẩn và Lời giải:
   - Nếu trong file đề đã có sẵn đáp án (được in đậm, gạch chân, hoặc có bảng đáp án ở cuối đề thi), hãy lấy chính xác đáp án đó.
   - Nếu đề thi CHƯA có đáp án hoặc chưa có lời giải, hãy giải chính xác 100% để gán đáp án đúng cho từng câu, đồng thời viết "Lời giải chi tiết" (explanation) rõ ràng để học sinh đối chiếu sau khi nộp bài.
3. Trích xuất hoặc suy luận:
   - Tiêu đề đề thi (title): lấy theo tiêu đề trong file hoặc gợi ý theo môn học
   - Môn học (subject): ví dụ Công Nghệ Công Nghiệp, Toán, Sinh học, Lịch sử, Hóa học, Vật lí...
   - Khối lớp (grade): ví dụ Lớp 10, Lớp 11, Lớp 12
   - Thời gian làm bài (durationMinutes): nếu trong file có ghi thời gian (ví dụ 45 phút, 50 phút, 90 phút) hãy lấy đúng số phút đó, nếu không ghi thì mặc định 45 phút.

YÊU CẦU ĐỊNH DẠNG ĐẦU RA BẮT BUỘC:
Trả về DUY NHẤT một chuỗi JSON hợp lệ theo cấu trúc:
{
  "title": "${examTitle || 'Đề kiểm tra trắc nghiệm'}",
  "subject": "${subject || 'Công Nghệ Công Nghiệp'}",
  "grade": "${grade || 'Lớp 12'}",
  "durationMinutes": 45,
  "description": "Đề thi được trích xuất trực tiếp từ file ${fileName}",
  "questions": [
    {
      "id": "q1",
      "type": "multiple_choice",
      "question": "Nội dung câu hỏi trắc nghiệm 4 lựa chọn...",
      "options": [
        {"id": "A", "text": "Nội dung lựa chọn A"},
        {"id": "B", "text": "Nội dung lựa chọn B"},
        {"id": "C", "text": "Nội dung lựa chọn C"},
        {"id": "D", "text": "Nội dung lựa chọn D"}
      ],
      "correctAnswer": "A",
      "explanation": "Lời giải chi tiết..."
    },
    {
      "id": "q2",
      "type": "true_false",
      "context": "Đoạn thông tin bối cảnh hoặc bảng dữ liệu chung...",
      "question": "Dựa vào thông tin trên, hãy xác định tính Đúng/Sai của mỗi nhận định sau:",
      "statements": [
        {"id": "a", "text": "Nhận định a", "isCorrect": true, "explanation": "Giải thích chi tiết nhận định a..."},
        {"id": "b", "text": "Nhận định b", "isCorrect": false, "explanation": "Giải thích chi tiết nhận định b..."},
        {"id": "c", "text": "Nhận định c", "isCorrect": true, "explanation": "Giải thích chi tiết nhận định c..."},
        {"id": "d", "text": "Nhận định d", "isCorrect": false, "explanation": "Giải thích chi tiết nhận định d..."}
      ]
    }
  ]
}`;

      let contents: unknown;
      if (mimeType === 'application/pdf' && base64Data) {
        contents = {
          parts: [
            {
              inlineData: {
                mimeType: 'application/pdf',
                data: String(base64Data),
              },
            },
            {
              text: promptInstructions,
            },
          ],
        };
      } else {
        const textContent =
          String(extractedText || '').trim() || `File tài liệu đề thi: ${fileName}`;
        contents = `${promptInstructions}\n\nNỘI DUNG VĂN BẢN TRÍCH XUẤT TỪ FILE "${fileName}":\n"""\n${textContent.slice(0, 50000)}\n"""`;
      }

      const responseText = await generateWithRetry(
        aiClient,
        contents,
        systemInstruction
      );

      try {
        const parsed = parseJsonResponse(responseText);
        res.json(parsed);
      } catch (parseErr) {
        console.error('JSON Parse error from Gemini extract-from-file:', parseErr);
        res.status(502).json({
          error:
            'Dữ liệu AI trích xuất từ tệp không đúng chuẩn JSON. Vui lòng thử lại.',
        });
      }
    } catch (err: unknown) {
      console.error('Server Gemini extract-from-file error:', err);
      const details = extractErrorDetails(err);
      res
        .status(details.statusCode)
        .json({ error: details.message, code: details.code });
    }
  });

  apiRouter.all('*', (_req, res) => {
    res.status(404).json({ error: 'API endpoint không tồn tại.' });
  });

  app.use('/api', apiRouter);
  app.use('/meonghiendien/api', apiRouter);

  const distPath = path.resolve(__dirname, 'dist');
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    try {
      const { createServer: createViteServer } = await import('vite');
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: 'spa',
      });
      app.use(vite.middlewares);
    } catch (viteErr) {
      console.warn('Vite dev server unavailable, serving dist static files:', viteErr);
      app.use(express.static(distPath));
      app.get('*', (_req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
      });
    }
  } else {
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`SmartTest server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
