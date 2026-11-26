/** Hand a blob to the browser as a download named `fileName`. */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  // After the click has handed the blob to the browser's download.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
