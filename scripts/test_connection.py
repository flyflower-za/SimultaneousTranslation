#!/usr/bin/env python3
"""
测试火山引擎 API 连接
"""
import asyncio
import json
import websockets
import sys
import os

# 添加项目路径
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from backend.volcengine_client import VolcengineASTClient

async def test_connection():
    """测试连接"""
    # 加载配置
    config_path = os.path.join(os.path.dirname(__file__), "config", "config.json")
    if not os.path.exists(config_path):
        print(f"错误: 配置文件不存在: {config_path}")
        return
    
    with open(config_path, "r", encoding="utf-8") as f:
        config = json.load(f)
    
    volc_config = config["volcengine"]
    translation_config = config.get("translation", {})
    
    print("=" * 50)
    print("测试火山引擎 API 连接")
    print("=" * 50)
    print(f"API Key: {volc_config['api_key'][:8]}...")
    print(f"Resource ID: {volc_config.get('resource_id', 'volc.service_type.10053')}")
    print(f"源语言: {translation_config.get('source_language', 'zh')}")
    print(f"目标语言: {translation_config.get('target_language', 'en')}")
    print("=" * 50)

    client = VolcengineASTClient(
        api_key=volc_config["api_key"],
        resource_id=volc_config.get("resource_id", "volc.service_type.10053"),
        source_lang=translation_config.get("source_language", "zh"),
        target_lang=translation_config.get("target_language", "en")
    )
    
    try:
        print("\n正在连接...")
        await client.connect()
        print("✓ 连接成功！")
        
        print("\n发送开始请求...")
        await client.send_start_request()
        print("✓ 开始请求已发送")
        
        print("\n等待响应（5秒）...")
        await asyncio.sleep(5)
        
        await client.close()
        print("\n✓ 测试完成")
        
    except websockets.exceptions.InvalidStatus as e:
        print(f"\n✗ 连接失败: {e}")
        print("\n可能的原因：")
        print("1. API 凭证无效或过期")
        print("2. 服务未开通或权限不足")
        print("3. Resource ID 不正确")
        print("\n请检查：")
        print("- 火山引擎控制台中服务是否已开通")
        print("- API 凭证是否正确")
        print("- Resource ID 是否正确（默认: volc.service_type.10053）")
        sys.exit(1)
    except Exception as e:
        print(f"\n✗ 错误: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

if __name__ == "__main__":
    asyncio.run(test_connection())

