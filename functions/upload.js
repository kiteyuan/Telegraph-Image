import { errorHandling, telemetryData } from "./utils/middleware";

export async function onRequestPost(context) {
    const { request, env } = context;

    try {
        const clonedRequest = request.clone();
        const formData = await clonedRequest.formData();

        await errorHandling(context);
        telemetryData(context);

        const uploadFile = formData.get('file');
        if (!uploadFile) {
            throw new Error('No file uploaded');
        }

        const fileName = uploadFile.name;
        const fileExtension = fileName.split('.').pop().toLowerCase();

        const telegramFormData = new FormData();
        telegramFormData.append("chat_id", env.TG_Chat_ID);

        // 根据文件类型选择合适的上传方式
        let apiEndpoint;
        if (uploadFile.type.startsWith('image/')) {
            telegramFormData.append("photo", uploadFile);
            apiEndpoint = 'sendPhoto';
        } else if (uploadFile.type.startsWith('audio/')) {
            telegramFormData.append("audio", uploadFile);
            apiEndpoint = 'sendAudio';
        } else if (uploadFile.type.startsWith('video/')) {
            telegramFormData.append("video", uploadFile);
            apiEndpoint = 'sendVideo';
        } else {
            telegramFormData.append("document", uploadFile);
            apiEndpoint = 'sendDocument';
        }

        const result = await sendToTelegram(telegramFormData, apiEndpoint, env);

        if (!result.success) {
            throw new Error(result.error);
        }

        const fileId = getFileId(result.data);
        const sightengine = getSightengineConfig(env);
        let statusKey = "none";

        if (!fileId) {
            throw new Error('Failed to get file ID');
        }

        if (uploadFile.type.startsWith('image/') && sightengine) {
            try {
                console.log('Starting upload-time content moderation...');
                statusKey = await moderateUploadedImage(uploadFile, sightengine);
            } catch (error) {
                console.error('Upload-time moderation error:', error);
            }
        }

        // 将文件信息保存到 KV 存储
        if (env.img_url) {
            await env.img_url.put(`${fileId}.${fileExtension}`, "", {
                metadata: {
                    TimeStamp: Date.now(),
                    ListType: "None",
                    Label: statusKey,
                    liked: false,
                    fileName: fileName,
                    fileSize: uploadFile.size,
                }
            });
        }

        const responseItem = {
            statusKey,
        };

        if (statusKey === "adult") {
            responseItem.message = "图片涉嫌违规";
            responseItem.src = null;
        } else {
            responseItem.src = `/file/${fileId}.${fileExtension}`;
        }

        return new Response(
            JSON.stringify([responseItem]),
            {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            }
        );
    } catch (error) {
        console.error('Upload error:', error);
        return new Response(
            JSON.stringify({ error: error.message }),
            {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            }
        );
    }
}

function getFileId(response) {
    if (!response.ok || !response.result) return null;

    const result = response.result;
    if (result.photo) {
        return result.photo.reduce((prev, current) =>
            (prev.file_size > current.file_size) ? prev : current
        ).file_id;
    }
    if (result.document) return result.document.file_id;
    if (result.video) return result.video.file_id;
    if (result.audio) return result.audio.file_id;

    return null;
}

async function sendToTelegram(formData, apiEndpoint, env, retryCount = 0) {
    const MAX_RETRIES = 2;
    const apiUrl = `https://api.telegram.org/bot${env.TG_Bot_Token}/${apiEndpoint}`;

    try {
        const response = await fetch(apiUrl, { method: "POST", body: formData });
        const responseData = await response.json();

        if (response.ok) {
            return { success: true, data: responseData };
        }

        // 图片上传失败时转为文档方式重试
        if (retryCount < MAX_RETRIES && apiEndpoint === 'sendPhoto') {
            console.log('Retrying image as document...');
            const newFormData = new FormData();
            newFormData.append('chat_id', formData.get('chat_id'));
            newFormData.append('document', formData.get('photo'));
            return await sendToTelegram(newFormData, 'sendDocument', env, retryCount + 1);
        }

        return {
            success: false,
            error: responseData.description || 'Upload to Telegram failed'
        };
    } catch (error) {
        console.error('Network error:', error);
        if (retryCount < MAX_RETRIES) {
            await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1)));
            return await sendToTelegram(formData, apiEndpoint, env, retryCount + 1);
        }
        return { success: false, error: 'Network error occurred' };
    }
}

function getSightengineConfig(env) {
    const apiUser = env.SightengineApiUser || env.SIGHTENGINE_API_USER;
    const apiSecret = env.SightengineApiSecret || env.SIGHTENGINE_API_SECRET;
    if (!apiUser || !apiSecret) return null;

    const models = env.SightengineModels || env.SIGHTENGINE_MODELS || "nudity-2.1";
    const explicitThresholdRaw = env.SightengineExplicitThreshold || env.SIGHTENGINE_EXPLICIT_THRESHOLD;
    const explicitThreshold = explicitThresholdRaw !== undefined ? Number(explicitThresholdRaw) : 0.6;

    return {
        apiUser: String(apiUser),
        apiSecret: String(apiSecret),
        models: String(models),
        explicitThreshold: Number.isFinite(explicitThreshold) ? explicitThreshold : 0.6,
    };
}

async function moderateUploadedImage(file, sightengine) {
    const form = new FormData();
    form.append("media", file, file.name || "image");
    form.append("models", sightengine.models);
    form.append("api_user", sightengine.apiUser);
    form.append("api_secret", sightengine.apiSecret);

    const res = await fetch("https://api.sightengine.com/1.0/check.json", {
        method: "POST",
        body: form,
    });

    if (!res.ok) {
        console.error("Upload-time moderation API request failed: " + res.status);
        return "none";
    }

    const data = await res.json();
    if (data?.status !== "success") {
        console.error("Upload-time moderation API returned non-success status:", data);
        return "none";
    }

    return evaluateSightengineResult(data, sightengine).isAdult ? "adult" : "safe";
}

function evaluateSightengineResult(data, sightengine) {
    if (!data || data.status !== "success") {
        return { isAdult: false };
    }

    const nudity = data.nudity;
    if (!nudity) return { isAdult: false };

    const sexualActivity = Number(nudity.sexual_activity) || 0;
    const sexualDisplay = Number(nudity.sexual_display) || 0;
    const erotica = Number(nudity.erotica) || 0;

    return {
        isAdult: Math.max(sexualActivity, sexualDisplay, erotica) >= sightengine.explicitThreshold,
    };
}
