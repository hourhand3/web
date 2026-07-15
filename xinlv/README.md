# rPPG 心率检测网页应用

基于远程光电容积描记法（remote Photoplethysmography, rPPG），通过电脑或手机自带摄像头观测人脸皮肤的细微颜色变化（血流引起的反射光变化），非接触式地测量心率。

## 快速开始

### 环境要求
- **浏览器**：Chrome/Edge 90+、Safari 14+、Firefox 88+
- **协议**：必须使用 HTTPS 或 `localhost`（浏览器安全策略要求）
- **摄像头**：带自动曝光的 USB 摄像头或手机前置/后置摄像头
- **光线**：均匀明亮的环境光，避免逆光

### 运行方式

由于浏览器限制摄像头必须在 HTTPS/localhost 下使用，请使用本地服务器：

```bash
# 方式 1: Python 3
cd xinlv
python -m http.server 8080

# 方式 2: Node.js (npx)
cd xinlv
npx serve -l 8080

# 方式 3: VS Code Live Server 插件
# 右键 index.html → Open with Live Server
```

然后浏览器访问 `http://localhost:8080`。

### 手机访问
- 手机和电脑同一局域网
- 电脑用 `ngrok http 8080` / `cloudflared tunnel` 获得 HTTPS 公网地址
- 或直接把文件部署到任意 HTTPS 静态托管（GitHub Pages / Vercel / Netlify）

## 使用步骤

1. 点击 **开始检测**，允许摄像头权限
2. 等待摄像头曝光稳定（约 1-2 秒）
3. 将面部正对摄像头，距离 30-50 厘米，保持额头和脸颊在画面中
4. 保持静止，不说话、不移动头部
5. 30 秒后 BPM 数值趋于稳定，置信度 ≥ 65% 视为可靠

## 项目结构

```
xinlv/
├── index.html              主页面（响应式布局）
├── css/
│   └── style.css           样式（深色主题 + 移动端适配）
└── js/
    ├── camera.js           CameraManager：摄像头采集 + 前后切换 + FPS
    ├── faceDetector.js     FaceDetector：MediaPipe FaceMesh + ROI 提取
    ├── rppgProcessor.js    RPPGProcessor：信号处理 + 滤波 + BPM
    ├── visualizer.js       Visualizer：Canvas 绘制 + UI 更新
    └── app.js              RPPGApp：主控制器，串联各模块
```

## 技术架构

```
摄像头帧 → 人脸检测 (FaceMesh) → ROI (前额/双颊) 像素采样
                                          ↓
                     RGB 均值缓冲 (滑动窗口 ~ 300 帧)
                                          ↓
             ┌──────────────────────────────────────────┐
             │  rPPG 算法 (三选一)                      │
             │  • POS    (2016, 推荐, 抗噪性好)         │
             │  • CHROM  (2013, 抗运动伪影)             │
             │  • Green  (基线法, 绿色通道)             │
             └──────────────────────────────────────────┘
                                          ↓
                         去趋势 → 归一化 → 带通滤波 (0.7~4 Hz)
                                          ↓
                 峰值检测 (Prominence+IQR) + FFT 双重验证
                                          ↓
                         BPM 中值平滑 + 置信度 → 实时显示
```

## rPPG 核心算法

### POS (Plane Orthogonal to Skin) [Wang et al., 2016]
将皮肤反射率 RGB 在 3D 空间投影到与肤色主轴正交的平面，抑制光照干扰。用长度 32 的滑动窗口逐帧生成 PPG 信号。**默认推荐算法**。

### CHROM (Chrominance) [de Haan & Jeanne, 2013]
将 RGB 转为 X=3R-2G、Y=1.5R+G-1.5B 的色度空间，抑制亮度噪声。适合运动较少的场景。

### Green Channel
血红蛋白对 520–570 nm 绿光吸收最强，因此绿色通道信噪比最高。作为基线法对比使用。

### 信号后处理
- **去趋势**：滑动均值基线消除（去除曝光/环境光缓慢漂移）
- **Butterworth 带通滤波**：0.7–4.0 Hz（42–240 BPM），filtfilt 零相位
- **FFT 辅助**：当检测到的有效峰不足时，自动降级为 FFT 频率峰值估计
- **置信度融合**：R-R 间期变异系数 (CV) × 峰数量比 × SNR

## 支持的特性

| 特性 | 说明 |
|------|------|
| 📱 跨平台 | 桌面 (Windows/Mac/Linux) + 移动端 (iOS Safari / Android Chrome) |
| 🔄 摄像头切换 | 枚举设备循环切换，移动端 user/environment |
| 🎯 ROI 选择 | 前额 + 双颊（可独立开关），基于 468 人脸关键点动态计算 |
| 🎛 算法切换 | POS / CHROM / Green Channel 三选一 |
| 📊 实时波形 | Canvas 绘制原始信号 + 滤波后信号 |
| ⚖️ 信号质量 | 多指标融合置信度评分 + 稳定度百分比 |
| 🖼 响应式 UI | 900px 以下自动单列布局，640px 以下按钮紧凑化 |
| 💾 设置持久化 | localStorage 记忆算法/窗口/ROI 偏好 |
| 🎨 调试模式 | 可选显示 468 个人脸关键点叠加层 |

---

## ⚠️ 关键难点与分析

### 1. 光照变化与自动曝光 (最大难点)
**现象**：摄像头启动初期 AE/AWB 收敛慢；环境光变化（窗外阳光、开关灯）直接污染信号。  
**影响**：BPM 漂移、信噪比骤降、峰值检测失败。  
**当前措施**：
- 前 60 帧 (~2 秒) 丢弃等待稳定
- ROI 逐帧均值归一化
- 去趋势滑动窗去除低频漂移
- Butterworth 高通 0.7 Hz 抑制 < 42 BPM 成分

**改善方向**：
- 手动锁定摄像头 exposure/whiteBalance 约束 (仅 Chrome 桌面可用)
- 对 ROI 使用带亮度补偿的归一化 (例如 Self Quotient Image)
- 检测光照突变（帧间均值差）并丢弃该窗口

---

### 2. 头部运动伪影
**现象**：说话、表情、点头、呼吸起伏 → ROI 形变 + 运动模糊。  
**当前措施**：
- FaceMesh 关键点动态跟踪，ROI 始终贴合额头/脸颊
- POS/CHROM 算法本身比纯 Green 抗运动
- IQR 过滤异常 R-R 间期

**改善方向**：
- 引入 Lucas-Kanade 光流估计运动强度，高运动时降权/跳过
- 人脸对齐 (Procrustes) 后再采样 ROI，减少刚性运动
- 多帧 ECC 配准 + 盲去卷积恢复运动模糊

---

### 3. 移动设备性能 & 采样抖动
**现象**：低端手机 FaceMesh 推理 < 10 FPS；帧间隔抖动严重 → 时域滤波/FFT 失准。  
**当前措施**：
- 移动端自动降分辨率 (480×360)
- FaceMesh 限制为每 66ms 调一次（≈15 FPS），不阻塞采集
- ROI 像素降步长采样（按 ROI 尺寸动态决定 step）
- BPM 估计同时基于实际 timestamp，而非假设恒定 FPS

**改善方向**：
- 把信号处理转移到 Web Worker 线程，避免主线程阻塞
- 线性插值 / 样条插值重采样到恒定时钟，再滤波
- 用 WASM / ONNX Runtime Web 替代 MediaPipe 的 ASM.js 路径

---

### 4. ROI 质量与遮挡
**现象**：刘海、帽子遮挡前额；脸颊被手、头发、眼镜框遮挡 → ROI 混入非皮肤像素。  
**当前措施**：
- 前额用眉弓 + 发迹关键点约束高度
- 脸颊仅取眼下-鼻侧的三角区域（关键点 234/454 作为内界）
- 支持双颊/前额独立开关

**改善方向**：
- 加入皮肤分割模型 (例如 MediaPipe Selfie Segmentation)，仅对皮肤像素做均值
- 每帧对 ROI 做方差/亮度质检，异常帧不进入缓冲
- 增加"鼻部 ROI"作为额外信号源（抗刘海遮挡）

---

### 5. 个体差异与肤色
**现象**：深色皮肤 melanin 高 → 绿光穿透弱，信噪比下降；痤疮/红斑不均也有影响。  
**当前措施**：
- 归一化 + 多通道融合算法 (POS/CHROM) 减轻肤色依赖
- 用 YCbCr 皮肤概率可加权采样（在 sampleROIPixels 中可扩展）

**改善方向**：
- 运行 IR-PPG 标定（如果设备有红外摄像头，手机极少有）
- 自适应选择 ROI：在 3 个区域中每帧选信噪比最高的
- 对深色皮肤使用 Red + CHROM 组合而非 Green

---

### 6. 浏览器/设备兼容
**已知问题**：
- iOS Safari 必须 `playsinline + webkit-playsinline`（已处理）
- iOS 14.5+  getUserMedia 在非 HTTPS 下完全不可用
- 部分安卓 Chrome 切换后置摄像头时 `facingMode` 被忽略，改用 `deviceId` 枚举切换（已实现）
- Firefox 不支持 MediaPipe FaceMesh WASM 的某些 SIMD 指令，需 fallback

**改善方向**：
- 降级方案：如果 FaceMesh 加载失败，回退到 Viola-Jones (tracking.js) 人脸检测 + 固定比例 ROI
- 用 Capabilities API 查询并展示当前摄像头分辨率/FPS
- Service Worker 缓存 CDN 资源，允许离线使用

---

### 7. 临床精度与鲁棒性
**注意**：本项目属于**演示/健康监测用途，非医疗器械**。  
在静止 + 良好光照下，与指夹 PPG 参考误差通常 ±3–5 BPM；运动/暗光下误差可达 ±10 BPM 以上。

**改善方向**：
- 引入卡尔曼滤波融合 BPM 历史 + 先验生理模型 (40-180 BPM)
- HRV (心率变异性) 时域/频域指标，用于判断信号是否可靠
- 长时间连续测量的动态校准（用户手动输入一次 PPG 参考值）

---

## 🛠 可扩展的改进清单（按优先级）

| 优先级 | 项目 | 工作量 | 收益 |
|--------|------|--------|------|
| P0 | Web Worker 分离信号处理 | M | 移动端卡顿 ↓ |
| P0 | 光照突变检测与跳过 | S | 误报 ↓ 40% |
| P1 | 皮肤分割后采样 | M | 抗遮挡 |
| P1 | 每帧 ROI 质量评分 | S | 稳定度指标更准 |
| P1 | 运动强度估计降权 | M | 抗说话/点头 |
| P2 | 多算法动态切换 | M | 自适应场景 |
| P2 | HRV 指标 (RMSSD, LF/HF) | M | 丰富功能 |
| P2 | 历史记录 + 趋势图 | M | 用户价值 |
| P3 | PWA 离线支持 | S | 可安装 |
| P3 | 导出原始信号 CSV | S | 研究分析 |
| P3 | 与智能手环 BLE 校准 | L | 精度提升 |

## 引用文献

1. Wang, W., Brinker, A. C., Stuijk, S., & de Haan, G. (2016). A novel algorithm for remote photoplethysmography: Spatial subspace rotation. IEEE TBME, 63(9), 1974-1984.
2. de Haan, G., & Jeanne, V. (2013). Robust pulse rate from chrominance-based rPPG. IEEE TBME, 60(10), 2878-2886.
3. McDuff, D. J., et al. (2014). Detecting pulse from head motions in video. CVPR Workshops.

---

## License

本项目仅用于学习研究。请勿用于医疗诊断。
