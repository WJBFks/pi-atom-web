export const imageUrl = (image) =>
  image?.url || `data:${image?.mimeType || "image/png"};base64,${image?.data || ""}`;

export const readImageFile = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`无法读取图片：${file.name}`));
    reader.onload = () => {
      const value = String(reader.result || "");
      resolve({
        name: file.name || "图片",
        mimeType: file.type,
        data: value.slice(value.indexOf(",") + 1),
        url: value,
        size: file.size,
      });
    };
    reader.readAsDataURL(file);
  });

export const readImageFiles = (files) =>
  Promise.all(
    [...files]
      .filter((file) => file?.type?.startsWith("image/"))
      .map(readImageFile),
  );

export const imagePayload = (images) =>
  (images || []).map(({ mimeType, data }) => ({ type: "image", mimeType, data }));
