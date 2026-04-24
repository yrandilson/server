import { invokeLLM } from "./_core/llm";
import { storagePut } from "./storage";
import {
  createDeclaration,
  createReimbursement,
  createAnomaly,
  createDocument,
  createAuditLog,
  getHistoricalAverageByNCM,
  getReimbursementByDeclarationId,
  updateReimbursementStatus,
  updateAnomalyStatus,
  getAnomalyByReimbursementId,
} from "./db";

/**
 * Valida os dados extraídos do documento
 */
function validateExtractedData(data: any): {
  declarationNumber: string;
  ncm: string;
  paidValue: string;
  paidTariff: string;
  currentTariff: string;
  declarationDate: Date;
} {
  if (!data.declarationNumber || typeof data.declarationNumber !== "string") {
    throw new Error("Nº da Declaração inválido ou ausente");
  }
  if (!data.ncm || !/^\d{8}$/.test(data.ncm)) {
    throw new Error("NCM deve ser um código de 8 dígitos");
  }
  const paidValue = parseFloat(data.paidValue);
  if (isNaN(paidValue) || paidValue < 0) {
    throw new Error("Valor Pago deve ser um número positivo");
  }
  const paidTariff = parseFloat(data.paidTariff);
  if (isNaN(paidTariff) || paidTariff < 0 || paidTariff > 100) {
    throw new Error("Alíquota Paga deve estar entre 0 e 100");
  }
  const currentTariff = parseFloat(data.currentTariff);
  if (isNaN(currentTariff) || currentTariff < 0 || currentTariff > 100) {
    throw new Error("Alíquota Vigente deve estar entre 0 e 100");
  }
  const declarationDate = new Date(data.declarationDate);
  if (isNaN(declarationDate.getTime())) {
    throw new Error("Data da Declaração inválida");
  }
  return {
    declarationNumber: data.declarationNumber,
    ncm: data.ncm,
    paidValue: paidValue.toString(),
    paidTariff: paidTariff.toString(),
    currentTariff: currentTariff.toString(),
    declarationDate,
  };
}

/**
 * Extrai dados de um documento fiscal usando LLM/OCR
 */
export async function extractDocumentData(documentUrl: string): Promise<{
  declarationNumber: string;
  ncm: string;
  paidValue: string;
  paidTariff: string;
  currentTariff: string;
  declarationDate: Date;
}> {
  const prompt = `
    Analise este documento fiscal e extraia os seguintes dados:
    - Nº da Declaração (número único do documento)
    - NCM (Nomenclatura Comum do Mercosul - código de 8 dígitos)
    - Valor Pago (valor total pago em reais)
    - Alíquota Paga (percentual de tarifa que foi pago)
    - Alíquota Vigente (percentual de tarifa atual)
    - Data da Declaração (data do documento)
    
    Retorne os dados em formato JSON com as chaves: declarationNumber, ncm, paidValue, paidTariff, currentTariff, declarationDate
  `;

  const response = await invokeLLM({
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: prompt,
          },
          {
            type: "file_url",
            file_url: {
              url: documentUrl,
              mime_type: "application/pdf",
            },
          },
        ],
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "document_extraction",
        strict: true,
        schema: {
          type: "object",
          properties: {
            declarationNumber: { type: "string" },
            ncm: { type: "string" },
            paidValue: { type: "string" },
            paidTariff: { type: "string" },
            currentTariff: { type: "string" },
            declarationDate: { type: "string" },
          },
          required: ["declarationNumber", "ncm", "paidValue", "paidTariff", "currentTariff", "declarationDate"],
          additionalProperties: false,
        },
      },
    },
  });

  const content = response.choices[0]?.message.content;
  if (!content || typeof content !== "string") {
    throw new Error("Falha ao extrair dados do documento");
  }

  const parsed = JSON.parse(content);
  return validateExtractedData(parsed);
}

/**
 * Calcula o valor de reembolso baseado na diferença de alíquotas
 * Fórmula: Reembolso = Valor Pago × (Alíquota Paga - Alíquota Vigente) / 100
 */
export function calculateReimbursement(
  paidValue: number,
  paidTariff: number,
  currentTariff: number
): { reimbursementValue: number; status: string } {
  const tariffDifference = paidTariff - currentTariff;

  // Se não há diferença de alíquota, não há reembolso
  if (tariffDifference <= 0) {
    return {
      reimbursementValue: 0,
      status: "Pendente",
    };
  }

  // Calcula reembolso: Valor Pago × (Alíquota Paga - Alíquota Vigente) / 100
  const reimbursementValue = (paidValue * tariffDifference) / 100;

  // Se o reembolso calculado é zero, marca como Pendente
  if (reimbursementValue === 0) {
    return {
      reimbursementValue: 0,
      status: "Pendente",
    };
  }

  // Caso contrário, está apto para reembolso
  return {
    reimbursementValue,
    status: "Apta para Reembolso",
  };
}

/**
 * Detecta anomalias no pedido de reembolso
 * Usa análise estatística simples (desvio padrão)
 */
export async function detectAnomalies(
  ncm: string,
  reimbursementValue: number
): Promise<{
  hasAnomaly: boolean;
  anomalyType?: string;
  anomalyScore?: number;
  historicalAverage?: number;
  deviationPercentage?: number;
  description?: string;
}> {
  const historicalAverage = await getHistoricalAverageByNCM(ncm);

  if (historicalAverage === 0) {
    return { hasAnomaly: false };
  }

  const deviation = Math.abs(reimbursementValue - historicalAverage);
  const deviationPercentage = (deviation / historicalAverage) * 100;

  // Bloqueia se o valor for 300% maior que a média histórica
  const ANOMALY_THRESHOLD = 300;

  if (deviationPercentage > ANOMALY_THRESHOLD) {
    return {
      hasAnomaly: true,
      anomalyType: "OUTLIER_VALUE",
      anomalyScore: Math.min(deviationPercentage / 100, 10),
      historicalAverage,
      deviationPercentage,
      description: `Valor de reembolso ${deviationPercentage.toFixed(2)}% acima da média histórica para NCM ${ncm}`,
    };
  }

  return { hasAnomaly: false };
}

/**
 * Processa um upload de declaração completo
 */
export async function processDeclarationUpload(
  documentBuffer: Buffer,
  fileName: string,
  uploadedBy: number
): Promise<{
  declarationId: number;
  reimbursementId: number;
  anomalyId?: number;
  status: string;
  message: string;
}> {
  try {
    // 1. Faz upload do documento para S3
    const fileKey = `declarations/${Date.now()}-${fileName}`;
    const { url: documentUrl } = await storagePut(fileKey, documentBuffer, "application/pdf");

    // 2. Extrai dados do documento
    const extractedData = await extractDocumentData(documentUrl);

    // 3. Cria registro de declaração
    const declarationResult = await createDeclaration({
      declarationNumber: extractedData.declarationNumber,
      ncm: extractedData.ncm,
      paidValue: extractedData.paidValue,
      paidTariff: extractedData.paidTariff,
      currentTariff: extractedData.currentTariff,
      declarationDate: extractedData.declarationDate,
      documentUrl,
      extractedData,
      uploadedBy,
    });

    const declarationId = (declarationResult as any).insertId;

    // 4. Calcula reembolso
    const { reimbursementValue, status: calculatedStatus } = calculateReimbursement(
      parseFloat(extractedData.paidValue),
      parseFloat(extractedData.paidTariff),
      parseFloat(extractedData.currentTariff)
    );

    // 5. Cria registro de reembolso
    const reimbursementResult = await createReimbursement({
      declarationId,
      reimbursementValue: reimbursementValue.toString(),
      status: calculatedStatus,
    });

    const reimbursementId = (reimbursementResult as any).insertId;

    // 6. Detecta anomalias
    const anomalyDetection = await detectAnomalies(extractedData.ncm, reimbursementValue);

    let finalStatus = calculatedStatus;
    let anomalyId: number | undefined;

    if (anomalyDetection.hasAnomaly) {
      finalStatus = "Divergente";

      const anomalyResult = await createAnomaly({
        reimbursementId,
        anomalyType: anomalyDetection.anomalyType || "UNKNOWN",
        anomalyScore: (anomalyDetection.anomalyScore || 0).toString(),
        historicalAverage: (anomalyDetection.historicalAverage || 0).toString(),
        deviationPercentage: (anomalyDetection.deviationPercentage || 0).toString(),
        description: anomalyDetection.description,
      });

      anomalyId = (anomalyResult as any).insertId;

      // Atualiza status do reembolso para Divergente
      await updateReimbursementStatus(reimbursementId, "Divergente");
    }

    // 7. Registra auditoria
    await createAuditLog({
      userId: uploadedBy,
      action: "DECLARATION_UPLOADED",
      entityType: "declaration",
      entityId: declarationId,
      changes: {
        declarationNumber: extractedData.declarationNumber,
        ncm: extractedData.ncm,
        reimbursementValue,
        hasAnomaly: anomalyDetection.hasAnomaly,
      },
      reason: anomalyDetection.hasAnomaly ? anomalyDetection.description : undefined,
    });

    return {
      declarationId,
      reimbursementId,
      anomalyId,
      status: finalStatus,
      message: anomalyDetection.hasAnomaly
        ? "Declaração processada com anomalia detectada. Aguardando revisão manual."
        : "Declaração processada com sucesso.",
    };
  } catch (error) {
    console.error("[ProcessDeclaration] Error:", error);
    // Registra erro em auditoria
    await createAuditLog({
      userId: uploadedBy,
      action: "DECLARATION_UPLOAD_FAILED",
      entityType: "declaration",
      entityId: 0,
      reason: error instanceof Error ? error.message : "Erro desconhecido",
    });
    throw error;
  }
}

/**
 * Aprova um reembolso e dispara webhook
 */
export async function approveReimbursement(
  reimbursementId: number,
  approvedBy: number,
  approvalReason?: string
): Promise<void> {
  await updateReimbursementStatus(reimbursementId, "Aprovado", approvedBy, approvalReason);

  // Registra auditoria
  await createAuditLog({
    userId: approvedBy,
    action: "REIMBURSEMENT_APPROVED",
    entityType: "reimbursement",
    entityId: reimbursementId,
    reason: approvalReason,
  });
}

/**
 * Rejeita um reembolso
 */
export async function rejectReimbursement(
  reimbursementId: number,
  rejectedBy: number,
  rejectionReason?: string
): Promise<void> {
  await updateReimbursementStatus(reimbursementId, "Rejeitado", rejectedBy, rejectionReason);

  // Registra auditoria
  await createAuditLog({
    userId: rejectedBy,
    action: "REIMBURSEMENT_REJECTED",
    entityType: "reimbursement",
    entityId: reimbursementId,
    reason: rejectionReason,
  });
}

/**
 * Aprova uma anomalia e atualiza o reembolso
 */
export async function approveAnomaly(
  anomalyId: number,
  reviewedBy: number,
  reviewReason?: string
): Promise<void> {
  const anomaly = await getAnomalyByReimbursementId(anomalyId);
  if (!anomaly) {
    throw new Error("Anomaly not found");
  }

  await updateAnomalyStatus(anomalyId, "Aprovado", reviewedBy, reviewReason);

  // Atualiza reembolso para "Apta para Reembolso"
  await updateReimbursementStatus(anomaly.reimbursementId, "Apta para Reembolso");

  // Registra auditoria
  await createAuditLog({
    userId: reviewedBy,
    action: "ANOMALY_APPROVED",
    entityType: "anomaly",
    entityId: anomalyId,
    reason: reviewReason,
  });
}

/**
 * Rejeita uma anomalia
 */
export async function rejectAnomaly(
  anomalyId: number,
  reviewedBy: number,
  reviewReason?: string
): Promise<void> {
  const anomaly = await getAnomalyByReimbursementId(anomalyId);
  if (!anomaly) {
    throw new Error("Anomaly not found");
  }

  await updateAnomalyStatus(anomalyId, "Rejeitado", reviewedBy, reviewReason);

  // Atualiza reembolso para "Rejeitado"
  await updateReimbursementStatus(anomaly.reimbursementId, "Rejeitado");

  // Registra auditoria
  await createAuditLog({
    userId: reviewedBy,
    action: "ANOMALY_REJECTED",
    entityType: "anomaly",
    entityId: anomalyId,
    reason: reviewReason,
  });
}
