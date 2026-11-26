function doGet() {
  return ContentService.createTextOutput('권한 승인이 끝났습니다. 이 창을 닫고 터미널로 돌아가세요.');
}

function doPost(event) {
  try {
    const request = JSON.parse(event.postData.contents);
    if (request.action === 'setup') {
      return jsonOutput({ ok: true, data: setupStorage() });
    }
    const spreadsheet = getConfiguredSpreadsheet();
    let data;
    if (request.action === 'read') data = readSheets(spreadsheet, request.tabs);
    else if (request.action === 'append') data = appendRows(spreadsheet, request.rows);
    else if (request.action === 'update') data = updateRow(spreadsheet, request);
    else if (request.action === 'saveGeminiResult') data = saveGeminiResult(spreadsheet, request.record);
    else if (request.action === 'listGeminiResults') data = listGeminiResults(spreadsheet, request.inspection_id);
    else if (request.action === 'runGemini') data = runGemini(request);
    else if (request.action === 'setOnePortKey') data = setOnePortKey(request);
    else if (request.action === 'savePhoto') data = savePhoto(request);
    else if (request.action === 'getPhoto') data = getPhoto(request.id);
    else throw createUserError('지원하지 않는 일입니다.');
    return jsonOutput({ ok: true, data: data });
  } catch (error) {
    const message = error && error.userMessage
      ? error.userMessage
      : '알 수 없는 오류가 났습니다.';
    return jsonOutput({ ok: false, error: message });
  }
}

function setupStorage() {
  const properties = PropertiesService.getScriptProperties();
  const spreadsheet = getOrCreateSpreadsheet(properties);
  const folder = getOrCreatePhotoFolder(properties);

  ensureSheetHeaders(spreadsheet, 'inspections', [
    'inspection_id',
    'product_id',
    'inspected_at',
    'revision',
    'weight_g',
    'memo',
    'decision',
    'content_version',
  ]);
  ensureSheetHeaders(spreadsheet, 'images', ['inspection_id', 'position', 'image_url']);
  ensureSheetHeaders(spreadsheet, 'gemini_results', [
    'result_id',
    'inspection_id',
    'created_at',
    'mode',
    'revision',
    'instruction_name',
    'instruction_text',
    'product_id',
    'weight_g',
    'images',
    'result',
  ]);
  removeEmptyDefaultSheet(spreadsheet);

  return { sheetUrl: spreadsheet.getUrl(), folderUrl: folder.getUrl() };
}

function getOrCreateSpreadsheet(properties) {
  const rememberedId = properties.getProperty('SHEET_ID');
  if (rememberedId) {
    try {
      return SpreadsheetApp.openById(rememberedId);
    } catch (error) {
      // Recreate the spreadsheet if the remembered file no longer exists.
    }
  }

  const spreadsheet = SpreadsheetApp.create('텀블러 공장 품질관리 데이터베이스');
  properties.setProperty('SHEET_ID', spreadsheet.getId());
  return spreadsheet;
}

function getOrCreatePhotoFolder(properties) {
  const rememberedId = properties.getProperty('FOLDER_ID');
  if (rememberedId) {
    try {
      return DriveApp.getFolderById(rememberedId);
    } catch (error) {
      // Recreate the folder if the remembered folder no longer exists.
    }
  }

  const folder = DriveApp.createFolder('텀블러 공장 품질검사 사진');
  properties.setProperty('FOLDER_ID', folder.getId());
  return folder;
}

function ensureSheetHeaders(spreadsheet, name, requiredHeaders) {
  let sheet = spreadsheet.getSheetByName(name);
  if (!sheet) sheet = spreadsheet.insertSheet(name);

  const lastColumn = sheet.getLastColumn();
  const existingHeaders = lastColumn > 0
    ? sheet.getRange(1, 1, 1, lastColumn).getValues()[0]
    : [];
  const missingHeaders = requiredHeaders.filter((header) => !existingHeaders.includes(header));
  if (missingHeaders.length > 0) {
    sheet.getRange(1, lastColumn + 1, 1, missingHeaders.length).setValues([missingHeaders]);
  }
}

function removeEmptyDefaultSheet(spreadsheet) {
  spreadsheet.getSheets().forEach((sheet) => {
    const isDefaultSheet = sheet.getName() === 'Sheet1' || sheet.getName() === '시트1';
    const isEmpty = sheet.getLastRow() === 0 && sheet.getLastColumn() === 0;
    if (isDefaultSheet && isEmpty) spreadsheet.deleteSheet(sheet);
  });
}

function createUserError(message) {
  const error = new Error(message);
  error.userMessage = message;
  return error;
}

function getConfiguredSpreadsheet() {
  const properties = PropertiesService.getScriptProperties();
  const spreadsheetId = properties.getProperty('SHEET_ID');
  const folderId = properties.getProperty('FOLDER_ID');
  if (!spreadsheetId || !folderId) {
    throw createUserError('시트와 사진 폴더가 아직 없습니다. npm.cmd run gas:init을 실행하세요.');
  }

  try {
    DriveApp.getFolderById(folderId);
    return SpreadsheetApp.openById(spreadsheetId);
  } catch (error) {
    throw createUserError('시트와 사진 폴더가 아직 없습니다. npm.cmd run gas:init을 실행하세요.');
  }
}

function readSheets(spreadsheet, tabNames) {
  if (!Array.isArray(tabNames)) throw new Error('탭 이름 목록이 필요합니다.');
  const result = {};
  tabNames.forEach((tabName) => {
    const sheet = spreadsheet.getSheetByName(tabName);
    result[tabName] = sheet ? readSheetRows(sheet) : [];
  });
  return result;
}

function readSheetRows(sheet) {
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  if (lastRow < 2 || lastColumn === 0) return [];

  const values = sheet.getRange(1, 1, lastRow, lastColumn).getValues();
  const headers = values[0];
  return values
    .slice(1)
    .filter((row) => row.some((value) => value !== '' && value !== null))
    .map((row) => {
      const item = {};
      headers.forEach((header, index) => {
        if (header !== '' && header !== null) item[header] = readCellValue(row[index]);
      });
      return item;
    });
}

function appendRows(spreadsheet, rowsByTab) {
  if (!rowsByTab || typeof rowsByTab !== 'object' || Array.isArray(rowsByTab)) {
    throw new Error('더할 줄을 확인하세요.');
  }

  let added = 0;
  Object.keys(rowsByTab).forEach((tabName) => {
    const rows = rowsByTab[tabName];
    if (!Array.isArray(rows)) throw new Error('더할 줄을 확인하세요.');
    const sheet = spreadsheet.getSheetByName(tabName);
    if (!sheet) throw new Error('시트 탭을 찾을 수 없습니다.');
    if (rows.length === 0) return;

    const headers = getSheetHeaders(sheet);
    if (headers.length === 0) throw new Error('시트 머리글을 찾을 수 없습니다.');
    const values = rows.map((row) => headers.map((header) => toSheetValue(row[header])));
    sheet.getRange(sheet.getLastRow() + 1, 1, values.length, headers.length).setValues(values);
    added += values.length;
  });
  return { added: added };
}

function updateRow(spreadsheet, request) {
  const sheet = spreadsheet.getSheetByName(request.tab);
  if (!sheet || !request || typeof request.key !== 'string' || !request.changes || typeof request.changes !== 'object') {
    throw new Error('수정할 기록이 없습니다.');
  }

  const headers = getSheetHeaders(sheet);
  const keyColumn = headers.indexOf(request.key);
  if (keyColumn < 0 || sheet.getLastRow() < 2) throw createUserError('수정할 기록이 없습니다.');

  const keyValues = sheet.getRange(2, keyColumn + 1, sheet.getLastRow() - 1, 1).getValues();
  const matchIndex = keyValues.findIndex((row) => valuesEqual(readCellValue(row[0]), request.value));
  if (matchIndex < 0) throw createUserError('수정할 기록이 없습니다.');

  const rowNumber = matchIndex + 2;
  Object.keys(request.changes).forEach((header) => {
    const column = headers.indexOf(header);
    if (column >= 0) sheet.getRange(rowNumber, column + 1).setValue(toSheetValue(request.changes[header]));
  });
  return { updated: 1 };
}

function saveGeminiResult(spreadsheet, record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('판독 결과를 확인하세요.');
  }

  const sheet = spreadsheet.getSheetByName('gemini_results');
  if (!sheet) throw new Error('시트 탭을 찾을 수 없습니다.');
  const headers = getSheetHeaders(sheet);
  if (headers.length === 0) throw new Error('시트 머리글을 찾을 수 없습니다.');
  sheet.getRange(sheet.getLastRow() + 1, 1, 1, headers.length)
    .setValues([headers.map((header) => toSheetValue(record[header]))]);
  return { saved: 1 };
}

function listGeminiResults(spreadsheet, inspectionId) {
  const sheet = spreadsheet.getSheetByName('gemini_results');
  if (!sheet) return { results: [] };
  const results = readSheetRows(sheet);
  return {
    results: typeof inspectionId === 'string' && inspectionId !== ''
      ? results.filter((record) => record.inspection_id === inspectionId)
      : results,
  };
}

function setOnePortKey(request) {
  if (!request || typeof request.key !== 'string' || request.key.trim() === '') {
    throw createUserError('OnePort 키가 .env에 없습니다.');
  }
  PropertiesService.getScriptProperties().setProperty('ONEPORT_API_KEY', request.key.trim());
  return { saved: true };
}

function runGemini(request) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('ONEPORT_API_KEY');
  if (!apiKey) throw createUserError('OnePort 키가 없습니다.');
  if (!request || typeof request.instruction !== 'string' || typeof request.product_name !== 'string' ||
      typeof request.weight !== 'string' || (request.revision !== 'Rev.A' && request.revision !== 'Rev.B') ||
      typeof request.standard !== 'string' || !Array.isArray(request.imageIds)) {
    throw createUserError('판독 정보를 확인하세요.');
  }

  const imageIds = request.imageIds;
  const photos = imageIds.map(getPhoto);
  const totalPhotoBytes = photos.reduce((total, photo) => total + Utilities.base64Decode(photo.base64).length, 0);
  if (totalPhotoBytes > 3 * 1024 * 1024) {
    throw createUserError('사진이 너무 커서 판독할 수 없습니다(코드 413).');
  }

  const content = [{
    type: 'text',
    text: [
      request.instruction,
      `제품: ${request.product_name}`,
      `중량: ${request.weight}`,
      `검사기준 버전: ${request.revision}`,
      `검사기준 원문:\n${request.standard}`,
    ].join('\n\n'),
  }];
  photos.forEach((photo) => {
    content.push({
      type: 'image_url',
      image_url: { url: `data:${photo.mimeType};base64,${photo.base64}` },
    });
  });

  let response;
  try {
    response = UrlFetchApp.fetch('https://oneport.kr/v1/chat/completions', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: `Bearer ${apiKey}` },
      payload: JSON.stringify({
        model: 'gemini-3.8-flash',
        messages: [{ role: 'user', content: content }],
        response_format: { type: 'json_object' },
        max_tokens: 8192,
      }),
      muteHttpExceptions: true,
    });
  } catch (error) {
    throw createUserError('OnePort에 연결하지 못했습니다. 2분쯤 뒤 다시 눌러 주세요.');
  }

  const code = response.getResponseCode();
  const body = response.getContentText();
  let result;
  try {
    result = JSON.parse(body);
  } catch (error) {
    throw createUserError('OnePort에 연결하지 못했습니다. 2분쯤 뒤 다시 눌러 주세요.');
  }

  if (code < 200 || code >= 300) {
    throw createUserError(getOnePortErrorMessage(code, result));
  }

  const answerText = result && result.choices && result.choices[0] && result.choices[0].message
    ? result.choices[0].message.content
    : null;
  const answer = parseGeminiAnswer(answerText);
  if (!answer) throw createUserError('Gemini 답이 6항목 형식이 아닙니다.');
  return answer;
}

function parseGeminiAnswer(value) {
  if (typeof value !== 'string') return null;
  let text = value.trim();
  if (text.indexOf('```') === 0) {
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  }
  let result;
  try {
    result = JSON.parse(text);
  } catch (error) {
    return null;
  }

  const fields = [
    '판정',
    '불량유형',
    '관찰·수치 근거',
    '적용 기준과 출처',
    '권고 조치',
    '사람 승인 필요 여부',
  ];
  if (!result || typeof result !== 'object' || Array.isArray(result) ||
      (result['판정'] !== 'OK' && result['판정'] !== 'NG' && result['판정'] !== 'HOLD')) return null;
  const normalized = {};
  for (let index = 0; index < fields.length; index += 1) {
    if (typeof result[fields[index]] !== 'string') return null;
    normalized[fields[index]] = result[fields[index]];
  }
  return normalized;
}

function getOnePortErrorMessage(code, body) {
  const error = body && typeof body.error === 'object' ? body.error : {};
  const reason = error.reason;
  const type = error.type;
  const errorCode = error.code;
  if (code === 401 && reason === 'key_revoked') return '이 OnePort 키는 꺼져 있습니다(코드 401). 다른 키로 바꿔 주세요.';
  if (code === 401) return 'OnePort 키가 맞지 않습니다(코드 401). 키를 다시 넣어 주세요.';
  if (code === 402) return 'OnePort 잔액이 부족해 판독하지 못했습니다(코드 402). 다른 키로 바꿔 주세요.';
  if (code === 403) return '이 OnePort 키로는 판독 모델을 쓸 수 없습니다(코드 403). 다른 키로 바꿔 주세요.';
  if (code === 404) return 'OnePort에서 판독 모델을 찾지 못했습니다(코드 404). 모델 이름을 확인해 주세요.';
  if (code === 413) return '사진이 너무 커서 판독할 수 없습니다(코드 413).';
  if (code === 429 && (errorCode === 'key_limit_exceeded' || type === 'key_limit_exceeded')) {
    return 'OnePort 키의 사용 한도를 다 썼습니다(코드 429). 다른 키로 바꿔 주세요.';
  }
  if (code === 429 || code === 500 || code === 502 || code === 503 || code === 504) {
    return `AI 판독 서버가 붐빕니다(코드 ${code}). 2분쯤 뒤 다시 눌러 주세요.`;
  }
  const message = typeof error.message === 'string' ? redactOnePortKey(error.message) : '';
  return `OnePort 오류(코드 ${code}): ${message}`;
}

function redactOnePortKey(message) {
  const key = PropertiesService.getScriptProperties().getProperty('ONEPORT_API_KEY');
  return key ? message.split(key).join('[가림]').split(`Bearer ${key}`).join('Bearer [가림]') : message;
}

function getSheetHeaders(sheet) {
  const lastColumn = sheet.getLastColumn();
  if (lastColumn === 0) return [];
  return sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
}

function toSheetValue(value) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'number') return value;
  return "'" + String(value);
}

function readCellValue(value) {
  if (value instanceof Date) return Utilities.formatDate(value, 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');
  if (typeof value === 'string' && value.charAt(0) === "'") return value.slice(1);
  return value;
}

function valuesEqual(left, right) {
  if (left instanceof Date) left = readCellValue(left);
  if (right instanceof Date) right = readCellValue(right);
  return left === right;
}

function savePhoto(request) {
  if (typeof request.name !== 'string' || typeof request.mimeType !== 'string' || typeof request.base64 !== 'string') {
    throw new Error('사진 정보를 확인하세요.');
  }

  const properties = PropertiesService.getScriptProperties();
  const folderId = properties.getProperty('FOLDER_ID');
  if (!folderId) {
    throw createUserError('시트와 사진 폴더가 아직 없습니다. npm.cmd run gas:init을 실행하세요.');
  }

  const folder = DriveApp.getFolderById(folderId);
  const bytes = Utilities.base64Decode(request.base64);
  const blob = Utilities.newBlob(bytes, request.mimeType, request.name);
  const file = folder.createFile(blob);
  return { id: file.getId() };
}

function getPhoto(fileId) {
  if (typeof fileId !== 'string' || fileId === '') {
    throw createUserError('등록된 사진이 없습니다.');
  }

  const properties = PropertiesService.getScriptProperties();
  const folderId = properties.getProperty('FOLDER_ID');
  if (!folderId) {
    throw createUserError('시트와 사진 폴더가 아직 없습니다. npm.cmd run gas:init을 실행하세요.');
  }

  const folder = DriveApp.getFolderById(folderId);
  const files = folder.getFiles();
  while (files.hasNext()) {
    const file = files.next();
    if (file.getId() === fileId) {
      return {
        mimeType: file.getMimeType(),
        base64: Utilities.base64Encode(file.getBlob().getBytes()),
      };
    }
  }
  throw createUserError('등록된 사진이 없습니다.');
}

function jsonOutput(value) {
  return ContentService
    .createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}