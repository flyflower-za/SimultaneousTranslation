"""
文本纠正模块 - 用于纠正语音识别错误
支持用户自定义词库进行文本替换
"""
import json
import logging
import os
import re
from typing import Dict, List, Tuple

logger = logging.getLogger(__name__)


class TextCorrector:
    """文本纠正器"""

    def __init__(self, correction_dict: Dict[str, str] = None, correction_file: str = None):
        """
        初始化文本纠正器
        
        Args:
            correction_dict: 纠正字典 {错误文本: 正确文本}
            correction_file: 纠正词库文件路径（JSON格式）
        """
        self.corrections = {}

        # 从文件加载
        if correction_file and os.path.exists(correction_file):
            self.load_from_file(correction_file)

        # 从字典加载
        if correction_dict:
            self.corrections.update(correction_dict)

        # 构建正则表达式模式（按长度排序，长的优先匹配）
        self.patterns = self._build_patterns()

        logger.info(f"文本纠正器已初始化，包含 {len(self.corrections)} 个纠正规则")

    def load_from_file(self, file_path: str):
        """
        从JSON文件加载纠正词库
        
        Args:
            file_path: JSON文件路径，格式: {"错误文本": "正确文本", ...}
        """
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
                if isinstance(data, dict):
                    self.corrections.update(data)
                    logger.info(f"从文件加载了 {len(data)} 个纠正规则: {file_path}")
                else:
                    logger.warning(f"纠正词库文件格式错误，应为字典格式: {file_path}")
        except json.JSONDecodeError as e:
            logger.error(f"解析纠正词库文件失败: {e}, 文件: {file_path}")
        except Exception as e:
            logger.error(f"加载纠正词库文件失败: {e}, 文件: {file_path}")

    def add_correction(self, wrong_text: str, correct_text: str):
        """
        添加纠正规则
        
        Args:
            wrong_text: 错误文本
            correct_text: 正确文本
        """
        self.corrections[wrong_text] = correct_text
        # 重新构建模式
        self.patterns = self._build_patterns()
        logger.debug(f"添加纠正规则: '{wrong_text}' -> '{correct_text}'")

    def remove_correction(self, wrong_text: str):
        """
        移除纠正规则
        
        Args:
            wrong_text: 要移除的错误文本
        """
        if wrong_text in self.corrections:
            del self.corrections[wrong_text]
            # 重新构建模式
            self.patterns = self._build_patterns()
            logger.debug(f"移除纠正规则: '{wrong_text}'")

    def _build_patterns(self) -> List[Tuple[re.Pattern, str]]:
        """
        构建正则表达式模式列表
        
        Returns:
            [(pattern, replacement), ...] 列表，按长度降序排序
        """
        if not self.corrections:
            return []

        patterns = []
        # 按长度降序排序（长的优先匹配，避免短词覆盖长词）
        sorted_items = sorted(self.corrections.items(), key=lambda x: len(x[0]), reverse=True)

        for wrong_text, correct_text in sorted_items:
            try:
                # 转义特殊字符
                escaped = re.escape(wrong_text)
                # 创建正则表达式（支持词边界，避免部分匹配）
                pattern = re.compile(r'\b' + escaped + r'\b', re.IGNORECASE)
                patterns.append((pattern, correct_text))
            except re.error as e:
                logger.error(f"构建正则表达式失败: {wrong_text} -> {correct_text}, 错误: {e}")

        return patterns

    def correct_text(self, text: str) -> str:
        """
        纠正文本中的错误
        
        Args:
            text: 要纠正的文本
            
        Returns:
            纠正后的文本
        """
        if not text or not self.patterns:
            return text

        corrected_text = text
        corrections_made = []

        try:
            # 按顺序应用所有纠正规则
            for pattern, replacement in self.patterns:
                if pattern.search(corrected_text):
                    corrected_text = pattern.sub(replacement, corrected_text)
                    corrections_made.append(f"'{pattern.pattern}' -> '{replacement}'")

            # 如果进行了纠正，记录日志
            if corrections_made and corrected_text != text:
                logger.debug(f"文本已纠正: {len(corrections_made)} 处, 原始: '{text[:50]}...', 纠正后: '{corrected_text[:50]}...'")

            return corrected_text
        except Exception as e:
            logger.error(f"纠正文本时出错: {e}")
            return text

    def save_to_file(self, file_path: str):
        """
        保存纠正词库到文件
        
        Args:
            file_path: 保存路径
        """
        try:
            with open(file_path, 'w', encoding='utf-8') as f:
                json.dump(self.corrections, f, ensure_ascii=False, indent=2)
            logger.info(f"纠正词库已保存到: {file_path}")
        except Exception as e:
            logger.error(f"保存纠正词库失败: {e}, 文件: {file_path}")


# 全局纠正器实例
_global_corrector = None


def get_corrector(correction_dict: Dict[str, str] = None, correction_file: str = None) -> TextCorrector:
    """
    获取全局纠正器实例（单例模式）
    
    Args:
        correction_dict: 纠正字典
        correction_file: 纠正词库文件路径
        
    Returns:
        TextCorrector实例
    """
    global _global_corrector
    if _global_corrector is None:
        _global_corrector = TextCorrector(correction_dict, correction_file)
    return _global_corrector


def correct_text(text: str, correction_dict: Dict[str, str] = None, correction_file: str = None) -> str:
    """
    纠正文本的便捷函数
    
    Args:
        text: 要纠正的文本
        correction_dict: 纠正字典
        correction_file: 纠正词库文件路径
        
    Returns:
        纠正后的文本
    """
    if correction_dict is not None or correction_file is not None:
        # 如果提供了新的配置，创建新实例
        corrector = TextCorrector(correction_dict, correction_file)
        return corrector.correct_text(text)
    else:
        # 使用全局实例
        return get_corrector().correct_text(text)
