import { useEffect, useState } from "react";

export function useArtworkTint(url: string | null | undefined) {
  const [tint, setTint] = useState("255,122,26");
  useEffect(() => {
    setTint("255,122,26");
    if (!url) return;
    let cancelled = false;
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      if (cancelled) return;
      try {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 12;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) return;
        context.drawImage(image, 0, 0, 12, 12);
        const { data } = context.getImageData(0, 0, 12, 12);
        let r = 0,
          g = 0,
          b = 0,
          count = 0;
        for (let i = 0; i < data.length; i += 4) {
          const light = data[i] + data[i + 1] + data[i + 2];
          if (light < 90 || light > 690) continue;
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          count++;
        }
        if (count)
          setTint(
            `${Math.round(r / count)},${Math.round(g / count)},${Math.round(b / count)}`,
          );
      } catch {
        /* A cover without CORS keeps the legible default palette. */
      }
    };
    image.onerror = () => {};
    image.src = url;
    return () => {
      cancelled = true;
      image.onload = null;
      image.src = "";
    };
  }, [url]);
  return tint;
}
