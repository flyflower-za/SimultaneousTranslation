"""
音频处理工具模块
"""
import logging

logger = logging.getLogger(__name__)


def validate_audio_format(sample_rate: int, channels: int, bits_per_sample: int) -> bool:
    """
    验证音频格式是否符合要求
    
    Args:
        sample_rate: 采样率
        channels: 声道数
        bits_per_sample: 每采样位数
    
    Returns:
        是否符合要求
    """
    if sample_rate != 16000:
        logger.warning(f"采样率应为 16000，当前为 {sample_rate}")
        return False
    if channels != 1:
        logger.warning(f"声道数应为 1，当前为 {channels}")
        return False
    if bits_per_sample != 16:
        logger.warning(f"每采样位数应为 16，当前为 {bits_per_sample}")
        return False
    return True


def convert_to_pcm16_mono(audio_data: bytes,
                          input_sample_rate: int,
                          input_channels: int,
                          input_bits_per_sample: int) -> bytes:
    """
    将音频数据转换为 16kHz, 16bit, 单通道 PCM 格式
    
    注意：这是一个简化版本，实际应用中可能需要使用音频处理库如 pydub
    
    Args:
        audio_data: 原始音频数据
        input_sample_rate: 输入采样率
        input_channels: 输入声道数
        input_bits_per_sample: 输入每采样位数
    
    Returns:
        转换后的 PCM 数据
    """
    # 如果已经是目标格式，直接返回
    if (input_sample_rate == 16000 and
        input_channels == 1 and
        input_bits_per_sample == 16):
        return audio_data

    # 简化处理：如果格式不匹配，记录警告
    # 实际应用中应该使用音频处理库进行重采样和格式转换
    logger.warning(
        f"音频格式转换：{input_sample_rate}Hz, {input_channels}ch, {input_bits_per_sample}bit -> "
        f"16000Hz, 1ch, 16bit"
    )

    # 这里应该实现实际的转换逻辑
    # 由于浏览器端已经处理了格式转换，这里主要做验证
    return audio_data


def split_audio_chunks(audio_data: bytes,
                      sample_rate: int = 16000,
                      chunk_duration_ms: int = 80) -> list:
    """
    将音频数据分割成指定时长的数据包
    
    Args:
        audio_data: 音频数据
        sample_rate: 采样率
        chunk_duration_ms: 每个数据包的时长（毫秒）
    
    Returns:
        音频数据包列表
    """
    # 计算每个数据包的大小（字节）
    # 16bit = 2 bytes per sample, 单通道
    bytes_per_sample = 2
    samples_per_chunk = int(sample_rate * chunk_duration_ms / 1000)
    bytes_per_chunk = samples_per_chunk * bytes_per_sample

    chunks = []
    for i in range(0, len(audio_data), bytes_per_chunk):
        chunk = audio_data[i:i + bytes_per_chunk]
        if len(chunk) > 0:
            chunks.append(chunk)

    return chunks

