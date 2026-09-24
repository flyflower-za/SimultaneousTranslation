"""
文本过滤模块 - 用于过滤不文明用词
"""
import logging
import re
from typing import List

logger = logging.getLogger(__name__)


class TextFilter:
    """文本过滤器"""

    def __init__(self, word_list: List[str] = None):
        """
        初始化过滤器
        
        Args:
            word_list: 敏感词列表，如果为None则使用默认列表
        """
        if word_list is None:
            word_list = self._get_default_word_list()

        # 构建正则表达式模式
        # 使用 | 连接所有敏感词，支持部分匹配
        self.pattern = self._build_pattern(word_list)
        self.word_list = word_list
        logger.info(f"文本过滤器已初始化，包含 {len(word_list)} 个敏感词")

    def _get_default_word_list(self) -> List[str]:
        """
        获取默认敏感词列表
        
        Returns:
            敏感词列表
        """
        # 这里可以添加常见的敏感词
        # 注意：这是一个示例列表，实际使用时应该根据需求调整
        default_words = [
            # 可以在这里添加敏感词
            # 示例（已注释，避免误过滤）：
            "fuck", "shit", "damn","禁淫","傻逼","滚","傻子", "小鸡"
        ]

        # 如果列表为空，返回空列表（不进行过滤）
        return default_words

    def _build_pattern(self, word_list: List[str]) -> re.Pattern:
        """
        构建正则表达式模式
        
        Args:
            word_list: 敏感词列表
            
        Returns:
            编译后的正则表达式对象
        """
        if not word_list:
            # 如果没有敏感词，返回一个永远不匹配的模式
            return re.compile(r'(?!x)x')

        # 转义特殊字符并按长度排序（长的优先匹配）
        escaped_words = [re.escape(word) for word in sorted(word_list, key=len, reverse=True)]

        # 构建正则表达式：支持词边界或直接匹配
        pattern_str = '|'.join(escaped_words)

        try:
            return re.compile(pattern_str, re.IGNORECASE)
        except re.error as e:
            logger.error(f"构建正则表达式失败: {e}")
            return re.compile(r'(?!x)x')

    def filter_text(self, text: str, replacement: str = "***") -> str:
        """
        过滤文本中的敏感词
        
        Args:
            text: 要过滤的文本
            replacement: 替换字符串，默认为 "***"
            
        Returns:
            过滤后的文本
        """
        if not text or not self.word_list:
            return text

        try:
            # 使用正则表达式替换敏感词
            filtered_text = self.pattern.sub(replacement, text)

            # 如果文本被修改，记录日志（但不记录具体内容）
            if filtered_text != text:
                logger.debug(f"文本已过滤，原始长度: {len(text)}, 过滤后长度: {len(filtered_text)}")

            return filtered_text
        except Exception as e:
            logger.error(f"过滤文本时出错: {e}")
            return text

    def has_sensitive_words(self, text: str) -> bool:
        """
        检查文本是否包含敏感词
        
        Args:
            text: 要检查的文本
            
        Returns:
            如果包含敏感词返回True，否则返回False
        """
        if not text or not self.word_list:
            return False

        try:
            return bool(self.pattern.search(text))
        except Exception as e:
            logger.error(f"检查敏感词时出错: {e}")
            return False


# 全局过滤器实例
_global_filter = None


def get_filter(word_list: List[str] = None) -> TextFilter:
    """
    获取全局过滤器实例（单例模式）
    
    Args:
        word_list: 敏感词列表，仅在首次调用时生效
        
    Returns:
        TextFilter实例
    """
    global _global_filter
    if _global_filter is None:
        _global_filter = TextFilter(word_list)
    return _global_filter


def filter_text(text: str, replacement: str = "***", word_list: List[str] = None) -> str:
    """
    过滤文本的便捷函数
    
    Args:
        text: 要过滤的文本
        replacement: 替换字符串，默认为 "***"
        word_list: 敏感词列表，如果提供则创建新实例
        
    Returns:
        过滤后的文本
    """
    if word_list is not None:
        # 如果提供了新的词列表，创建新实例
        filter_instance = TextFilter(word_list)
        return filter_instance.filter_text(text, replacement)
    else:
        # 使用全局实例
        return get_filter().filter_text(text, replacement)
