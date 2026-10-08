function tooLarge() {
  return Object.assign(new Error('请求内容过大。'), { status:413 });
}

// Bound bytes while reading, including chunked bodies without Content-Length.
export async function readBoundedText(request, maximumBytes) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new TypeError('Invalid body limit');
  const declaredLength = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    if (request.body) void request.body.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        // Do not wait for a remote sender to finish before rejecting the body.
        void reader.cancel().catch(() => {});
        throw tooLarge();
      }
      chunks.push(value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks, totalBytes));
  } finally {
    reader.releaseLock();
  }
}
