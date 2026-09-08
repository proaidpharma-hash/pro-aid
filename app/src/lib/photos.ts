import { supabase, deviceLabel } from './supabase';

// Every money entry needs a photo. This module takes a File from the camera or gallery,
// shrinks it, uploads it to the private "proofs" bucket, and creates the photos row.
export type ProofPhoto = { id: string; storage_path: string; previewUrl: string };

async function compress(file: File, maxSide = 1600, quality = 0.82): Promise<Blob> {
  if (!/^image\//.test(file.type)) throw new Error('Please choose a photo');
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file;
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
  const blob = await compress(file);
  const hash = await sha256(blob);
  const d = new Date();
  const path = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${userId}/${Date.now()}-${hash.slice(0, 8)}.jpg`;
  const { error: upErr } = await supabase.storage.from('proofs').upload(path, blob, { contentType: 'image/jpeg', upsert: false });
  if (upErr) throw new Error('Photo upload failed: ' + upErr.message);
  const { data, error } = await supabase.from('photos').insert({ storage_path: path, taken_by: userId, device: deviceLabel(), sha256: hash }).select('id, storage_path').single();
  if (error) throw new Error('Photo record failed: ' + error.message);
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
