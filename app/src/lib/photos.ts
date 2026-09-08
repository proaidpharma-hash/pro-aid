import { supabase, deviceLabel } from './supabase';

// Every money entry needs a photo. This module takes a File from the camera or gallery,
// shrinks it, uploads it to the private "proofs" bucket, and creates the photos row.
export type ProofPhoto = { id: string; storage_path: string; previewUrl: string };

// Rejects photos nobody could read as proof: too dark, or badly out of focus. Small images (tests, icons) are not judged.
function checkQuality(bitmap: ImageBitmap) {
  if (Math.max(bitmap.width, bitmap.height) < 300) return;
  const c = document.createElement('canvas'); const side = 160;
  const scale = side / Math.max(bitmap.width, bitmap.height);
  c.width = Math.max(1, Math.round(bitmap.width * scale)); c.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = c.getContext('2d', { willReadFrequently: true }); if (!ctx) return;
  ctx.drawImage(bitmap, 0, 0, c.width, c.height);
  const { data } = ctx.getImageData(0, 0, c.width, c.height);
  const w = c.width, h = c.height; const g = new Float32Array(w * h); let sum = 0;
  for (let i = 0; i < w * h; i++) { const v = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]; g[i] = v; sum += v; }
  const mean = sum / (w * h);
  if (mean < 22) throw new Error('The photo is too dark to read — turn on the light or the flash and take it again');
  // sharpness: variance of a 4-neighbour Laplacian; a blurred picture has almost no edges
  let lapSum = 0, lapSq = 0, cnt = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; const l = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w]; lapSum += l; lapSq += l * l; cnt++; }
  const variance = cnt ? lapSq / cnt - (lapSum / cnt) ** 2 : 0;
  if (variance < 12) throw new Error('The photo is blurred — hold the phone still and take it again');
}

async function compress(file: File, maxSide = 1600, quality = 0.82): Promise<Blob> {
  if (!/^image\//.test(file.type)) throw new Error('Please choose a photo');
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file;
  checkQuality(bitmap);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) return file;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  // stamp: time and device, so a photo cannot pass as another day's proof
  const stamp = `${new Date().toLocaleString('en-GB')} · ${deviceLabel()}`;
  ctx.font = `${Math.max(14, Math.round(canvas.width / 40))}px sans-serif`;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  const w = ctx.measureText(stamp).width + 16;
  ctx.fillRect(8, canvas.height - 36, w, 28);
  ctx.fillStyle = '#fff';
  ctx.fillText(stamp, 16, canvas.height - 16);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b || file), 'image/jpeg', quality));
}

async function sha256(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const h = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function uploadProof(file: File, userId: string): Promise<ProofPhoto> {
  const original = await sha256(file);   // hash of the picture itself, before the stamp — the same picture twice is caught even minutes apart
  const blob = await compress(file);
  const hash = original;
  const d = new Date();
  const path = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${userId}/${Date.now()}-${hash.slice(0, 8)}.jpg`;
  const { error: upErr } = await supabase.storage.from('proofs').upload(path, blob, { contentType: 'image/jpeg', upsert: false });
  if (upErr) throw new Error('Photo upload failed: ' + upErr.message);
  const { data, error } = await supabase.from('photos').insert({ storage_path: path, taken_by: userId, device: deviceLabel(), sha256: hash }).select('id, storage_path').single();
  if (error) throw new Error(/photos_sha256_unique/.test(error.message) ? 'This exact photo was already used as proof for another entry — take a fresh photo' : 'Photo record failed: ' + error.message);
  return { id: data.id, storage_path: data.storage_path, previewUrl: URL.createObjectURL(blob) };
}

const urlCache = new Map<string, string>();
export async function proofUrl(storagePath: string): Promise<string> {
  const hit = urlCache.get(storagePath);
  if (hit) return hit;
  const { data, error } = await supabase.storage.from('proofs').createSignedUrl(storagePath, 60 * 60);
  if (error || !data) throw new Error('Could not open photo');
  let url = data.signedUrl;
  if (url.startsWith('/')) url = `${import.meta.env.VITE_SUPABASE_URL}/storage/v1${url}`;
  urlCache.set(storagePath, url);
  return url;
}
