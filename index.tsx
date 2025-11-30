import React, { useState, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  Plus,
  Trash2,
  BarChart3,
  FileSpreadsheet,
  Settings,
  FlaskConical,
  FileText,
  ClipboardPaste,
  Info,
  Download,
  Image as ImageIcon,
  Beaker,
  Calculator,
  X,
  CheckCircle2,
  AlertTriangle,
  XCircle
} from "lucide-react";

// Access global libraries from CDN
declare const jStat: any;
declare const jspdf: any;
declare const Chart: any;

// --- Types ---

type GeneType = "target" | "reference";

interface Gene {
  id: string;
  name: string;
  type: GeneType;
  efficiency: number; // e.g., 2.0 for 100%, 1.9 for 90%
}

interface Group {
  id: string;
  name: string;
  isControl: boolean;
  color: string;
}

interface Sample {
  id: string;
  groupId: string;
  replicate: number;
  ctValues: Record<string, number | null>; // geneId -> Ct value
}

interface GroupStatResult {
  groupId: string;
  groupName: string;
  meanNormalizedExpression: number;
  sem: number; // Standard Error of Mean
  sd: number;
  n: number;
  individualValues: number[];
  // For 2 groups
  pValue?: number; 
  significance?: string; // ns, *, **, etc.
  // For >2 groups (Letter based)
  markingLetter?: string; // a, b, ab, c...
}

interface AnalysisResult {
  geneId: string;
  geneName: string;
  anovaPValue?: number; // Global P value for the gene
  groupResults: GroupStatResult[];
}

// --- Constants & Helpers ---

const COLORS = [
  "#000000", // Black for Control
  "#fe0000", // Red for Treatment
  "#3b82f6", // blue-500
  "#10b981", // emerald-500
  "#f59e0b", // amber-500
  "#8b5cf6", // violet-500
  "#ec4899", // pink-500
];

const generateId = () => Math.random().toString(36).substring(2, 9);

const DEFAULT_GENES: Gene[] = [
  { id: "g_bactin", name: "β-actin", type: "reference", efficiency: 2.0 },
  { id: "g_s27", name: "S27", type: "reference", efficiency: 2.0 },
  { id: "g_target1", name: "GeneA", type: "target", efficiency: 2.0 },
];

const DEFAULT_GROUPS: Group[] = [
  { id: "grp_ctrl", name: "Control", isControl: true, color: COLORS[0] },
  { id: "grp_treat1", name: "Treatment1", isControl: false, color: COLORS[1] },
];

const getSignificanceLabel = (p: number | undefined) => {
  if (p === undefined || isNaN(p)) return "";
  if (p > 0.05) return "ns";
  if (p <= 0.0001) return "****";
  if (p <= 0.001) return "***";
  if (p <= 0.01) return "**";
  if (p <= 0.05) return "*";
  return "ns";
};

// Smart formatter: Use decimals for > 0.001 to avoid confusion (e.g. 6.23e-2 vs 0.05)
const formatPValue = (p: number | undefined) => {
  if (p === undefined || isNaN(p)) return "-";
  if (p < 0.001) return p.toExponential(2); // e.g., 1.23e-4
  return p.toFixed(4); // e.g., 0.0623
};

// Helper: Calculate Welch's t-test (Unpaired, unequal variance)
const calculateWelchTTest = (sample1: number[], sample2: number[]): number => {
  if (typeof jStat === 'undefined') return NaN;
  
  const n1 = sample1.length;
  const n2 = sample2.length;
  if (n1 < 2 || n2 < 2) return NaN;

  const m1 = jStat.mean(sample1);
  const m2 = jStat.mean(sample2);
  const v1 = jStat.variance(sample1, true); // true = sample variance
  const v2 = jStat.variance(sample2, true);

  // If variance is 0 (all values identical)
  if (v1 === 0 && v2 === 0) {
      return m1 === m2 ? 1.0 : 0.0;
  }

  // Standard Error
  const se = Math.sqrt((v1 / n1) + (v2 / n2));
  if (se === 0) return 0.0;

  // t-statistic
  const t = (m1 - m2) / se;

  // Degrees of Freedom (Welch-Satterthwaite equation)
  const dfNum = Math.pow((v1 / n1) + (v2 / n2), 2);
  const dfDen = (Math.pow(v1 / n1, 2) / (n1 - 1)) + (Math.pow(v2 / n2, 2) / (n2 - 1));
  const df = dfNum / dfDen;

  // Two-tailed P-value. Ensure t is absolute for jStat.
  return jStat.ttest(Math.abs(t), df, 2);
};

// Helper: Generate Compact Letter Display (CLD)
// 1. Calculate all pairwise P-values
// 2. Find maximal cliques of "not significantly different" groups
// 3. Assign letters
const generateLetterMarkings = (groupStats: GroupStatResult[]): Record<string, string> => {
  const ids = groupStats.map(g => g.groupId);
  const n = ids.length;
  const markingMap: Record<string, string> = {};
  
  // Sort groups by mean descending for conventional letter assignment (a = highest)
  const sortedStats = [...groupStats].sort((a, b) => b.meanNormalizedExpression - a.meanNormalizedExpression);
  const sortedIds = sortedStats.map(s => s.groupId);

  // Adjacency matrix for "No Significant Difference" (P > 0.05)
  // 1 = No Diff (connected), 0 = Sig Diff
  const adj: boolean[][] = Array(n).fill(null).map(() => Array(n).fill(false));

  for (let i = 0; i < n; i++) {
    // IMPORTANT: Self-loop must be false to avoid infinite recursion in Bron-Kerbosch
    adj[i][i] = false; 
    for (let j = i + 1; j < n; j++) {
      const g1 = sortedStats[i];
      const g2 = sortedStats[j];
      let p = 0;
      try {
         p = calculateWelchTTest(g1.individualValues, g2.individualValues);
      } catch (e) { p = 1; }
      
      const isNS = !isNaN(p) && p > 0.05;
      adj[i][j] = isNS;
      adj[j][i] = isNS;
    }
  }

  // Find Maximal Cliques (Bron-Kerbosch simplified)
  // A clique represents a set of groups that all share a letter
  const cliques: number[][] = [];
  
  // Simple recursive Bron-Kerbosch
  // R: current clique, P: candidates, X: excluded
  const findCliques = (R: number[], P: number[], X: number[]) => {
    if (P.length === 0 && X.length === 0) {
      if (R.length > 0) cliques.push(R);
      return;
    }
    const P_copy = [...P];
    for (const v of P_copy) {
      const neighbors = [];
      for(let k=0; k<n; k++) if(adj[v][k]) neighbors.push(k);
      
      findCliques(
        [...R, v],
        P.filter(node => neighbors.includes(node)),
        X.filter(node => neighbors.includes(node))
      );
      // Move v from P to X
      const pIdx = P.indexOf(v);
      if (pIdx > -1) P.splice(pIdx, 1);
      X.push(v);
    }
  };
  
  findCliques([], Array.from({length: n}, (_, i) => i), []);

  // Map cliques to letters
  const letters = "abcdefghijklmnopqrstuvwxyz";
  
  // Sort cliques by the minimum index (which corresponds to highest mean due to previous sort)
  // to ensure 'a' goes to the highest values.
  cliques.sort((c1, c2) => Math.min(...c1) - Math.min(...c2));

  const groupLetters: Record<string, string[]> = {};
  sortedIds.forEach(id => groupLetters[id] = []);

  cliques.forEach((clique, idx) => {
    const char = letters[idx % letters.length];
    clique.forEach(nodeIdx => {
      const id = sortedIds[nodeIdx];
      groupLetters[id].push(char);
    });
  });

  // Combine and Sort letters for each group
  Object.keys(groupLetters).forEach(id => {
    markingMap[id] = groupLetters[id].sort().join("");
  });

  return markingMap;
};


// --- Components ---

// Efficiency Calculator Modal
const EfficiencyCalculator = ({
  isOpen,
  onClose,
  genes,
  initialGeneId,
  onUpdateEfficiency
}: {
  isOpen: boolean;
  onClose: () => void;
  genes: Gene[];
  initialGeneId?: string;
  onUpdateEfficiency: (geneId: string, eff: number) => void;
}) => {
  const [selectedGeneId, setSelectedGeneId] = useState<string>(genes[0]?.id || "");
  const [inputText, setInputText] = useState("");
  const [dilutionFactor, setDilutionFactor] = useState(10); // Default 10-fold
  const [result, setResult] = useState<{slope: number, r2: number, efficiency: number, effPercent: number, points: {conc: number, ct: number}[]} | null>(null);
  const [error, setError] = useState("");

  // Sync selected gene when opened with initialGeneId
  useEffect(() => {
    if (isOpen && initialGeneId) {
        setSelectedGeneId(initialGeneId);
    } else if (isOpen && !selectedGeneId && genes.length > 0) {
        setSelectedGeneId(genes[0].id);
    }
  }, [isOpen, initialGeneId, genes]);

  const handleCalculate = () => {
    setError("");
    setResult(null);

    // Extract Ct values (one per line)
    const ctValues = inputText.trim().split(/[\r\n]+/)
        .map(v => parseFloat(v.trim()))
        .filter(n => !isNaN(n));

    if (ctValues.length < 3) {
      setError("至少需要 3 个有效的 Ct 值来进行计算。");
      return;
    }

    // Generate Points based on dilution factor
    // Point 0: Relative Conc 1 (Log10 = 0)
    // Point 1: Relative Conc 1/D (Log10 = -log10(D))
    // Point i: ...
    
    const points: {x: number, y: number, conc: number}[] = ctValues.map((ct, i) => {
        const conc = 1 / Math.pow(dilutionFactor, i);
        return {
            x: Math.log10(conc),
            y: ct,
            conc: conc
        };
    });

    // Linear Regression
    const n = points.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    
    points.forEach(p => {
      sumX += p.x;
      sumY += p.y;
      sumXY += p.x * p.y;
      sumXX += p.x * p.x;
    });

    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;

    // R2 Calculation
    let ssTotal = 0;
    let ssResid = 0;
    const meanY = sumY / n;

    points.forEach(p => {
      const predY = slope * p.x + intercept;
      ssTotal += Math.pow(p.y - meanY, 2);
      ssResid += Math.pow(p.y - predY, 2);
    });

    const r2 = 1 - (ssResid / ssTotal);
    
    // Efficiency Calculation
    // E = 10^(-1/slope)
    const efficiency = Math.pow(10, -1 / slope);
    const effPercent = (efficiency - 1) * 100;

    setResult({
      slope,
      r2,
      efficiency,
      effPercent,
      points: points.map(p => ({ conc: p.conc, ct: p.y }))
    });
  };

  const handleApply = () => {
    if (result && selectedGeneId) {
      // Limit to sensible bounds 
      onUpdateEfficiency(selectedGeneId, parseFloat(efficiency.toFixed(3)));
      onClose();
    }
  };
  
  // Feedback Logic
  const getFeedback = (effPercent: number, r2: number) => {
    const feedbacks: { type: "success" | "warning" | "error", msg: string }[] = [];
    let overallStatus: "success" | "warning" | "error" = "success";

    // Efficiency Analysis
    if (effPercent >= 90 && effPercent <= 110) {
        feedbacks.push({ type: "success", msg: "扩增效率 (90% - 110%): 优秀。引物特异性好，扩增效率理想。" });
    } else if ((effPercent >= 80 && effPercent < 90) || (effPercent > 110 && effPercent <= 120)) {
        overallStatus = "warning";
        feedbacks.push({ type: "warning", msg: "扩增效率 (80% - 120%): 可接受。略有偏差，可能存在引物二聚体或操作误差。" });
    } else {
        overallStatus = "error";
        feedbacks.push({ type: "error", msg: "扩增效率异常 (<80% 或 >120%): 不推荐使用。可能存在严重的引物二聚体、抑制剂或非特异性扩增。" });
    }

    // R2 Analysis
    if (r2 < 0.98) {
        overallStatus = overallStatus === "error" ? "error" : "warning";
        feedbacks.push({ type: "warning", msg: "R² < 0.98: 线性关系一般。可能存在移液误差或稀释梯度不准确。" });
    } else {
        feedbacks.push({ type: "success", msg: "R² ≥ 0.98: 线性关系良好。标准曲线拟合度高。" });
    }

    return { overallStatus, feedbacks };
  };

  if (!isOpen) return null;

  const efficiency = result?.efficiency || 0;
  const feedback = result ? getFeedback(result.effPercent, result.r2) : null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 animate-in fade-in duration-200">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh]">
        <div className="bg-slate-50 border-b border-slate-200 p-4 flex justify-between items-center">
          <h3 className="font-bold text-slate-800 flex items-center gap-2">
            <Calculator className="w-5 h-5 text-indigo-600"/>
            标准曲线效率计算器
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition-colors">
            <X className="w-5 h-5"/>
          </button>
        </div>
        
        <div className="p-6 overflow-y-auto">
           <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">选择基因</label>
                <select 
                  value={selectedGeneId}
                  onChange={(e) => setSelectedGeneId(e.target.value)}
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:outline-none bg-white"
                >
                  {genes.map(g => (
                    <option key={g.id} value={g.id}>{g.name} ({g.type === 'reference' ? '内参' : '目标'})</option>
                  ))}
                </select>
              </div>

              <div className="flex gap-4">
                 <div className="w-1/3">
                    <label className="block text-sm font-medium text-slate-700 mb-1">梯度稀释倍数</label>
                    <div className="relative">
                        <input
                           type="number"
                           min="2"
                           value={dilutionFactor}
                           onChange={(e) => setDilutionFactor(Math.max(2, parseInt(e.target.value) || 10))}
                           className="w-full border border-slate-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                        />
                        <span className="absolute right-3 top-2 text-slate-400 text-sm">X</span>
                    </div>
                    <p className="text-[10px] text-slate-400 mt-1">默认为10倍稀释 (1, 0.1, 0.01...)</p>
                 </div>
                 <div className="flex-1">
                    <label className="block text-sm font-medium text-slate-700 mb-1">
                      输入 Ct 值
                      <span className="ml-2 text-xs font-normal text-slate-500">(按相对浓度从高到低排列)</span>
                    </label>
                    <textarea
                      value={inputText}
                      onChange={(e) => setInputText(e.target.value)}
                      placeholder={`22.5\n25.8\n29.1\n32.5`}
                      className="w-full h-32 border border-slate-300 rounded-lg px-3 py-2 font-mono text-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                    />
                    <p className="text-xs text-slate-400 mt-1">直接粘贴一列 Ct 值即可。</p>
                 </div>
              </div>

              {error && (
                <div className="p-3 bg-red-50 text-red-600 text-sm rounded-lg border border-red-100 flex items-center gap-2">
                   <AlertTriangle className="w-4 h-4"/> {error}
                </div>
              )}

              {result && (
                <div className="space-y-4 animate-in fade-in slide-in-from-bottom-2">
                    {/* Data Preview */}
                    <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs">
                        <table className="w-full text-right">
                            <thead className="text-slate-500 border-b border-slate-200">
                                <tr>
                                    <th className="pb-1">相对浓度</th>
                                    <th className="pb-1 pr-4">Log(Conc)</th>
                                    <th className="pb-1">Ct 值</th>
                                </tr>
                            </thead>
                            <tbody className="font-mono text-slate-700">
                                {result.points.map((p, i) => (
                                    <tr key={i}>
                                        <td className="py-1">{p.conc.toString()}</td>
                                        <td className="py-1 pr-4">{Math.log10(p.conc).toFixed(2)}</td>
                                        <td className="py-1 font-bold">{p.ct.toFixed(2)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                    {/* Results Box */}
                    <div className="bg-indigo-50 border border-indigo-100 rounded-lg p-4 space-y-2">
                      <div className="flex justify-between items-center border-b border-indigo-100 pb-2">
                        <span className="text-sm text-indigo-700">斜率 (Slope):</span>
                        <span className="font-mono font-medium text-indigo-900">{result.slope.toFixed(4)}</span>
                      </div>
                      <div className="flex justify-between items-center border-b border-indigo-100 pb-2">
                        <span className="text-sm text-indigo-700">R² (拟合度):</span>
                        <span className={`font-mono font-medium ${result.r2 > 0.98 ? "text-green-600" : "text-amber-600"}`}>
                          {result.r2.toFixed(4)}
                        </span>
                      </div>
                      <div className="flex justify-between items-center pt-1">
                        <span className="text-sm font-bold text-indigo-800">计算扩增效率 (E):</span>
                        <div className="text-right">
                          <div className="font-bold text-xl text-indigo-600">{result.efficiency.toFixed(3)}</div>
                          <div className="text-xs text-indigo-500">({result.effPercent.toFixed(1)}%)</div>
                        </div>
                      </div>
                    </div>

                    {/* Analysis Feedback Box */}
                    {feedback && (
                        <div className={`rounded-lg p-4 border ${
                            feedback.overallStatus === "success" ? "bg-green-50 border-green-200" :
                            feedback.overallStatus === "warning" ? "bg-amber-50 border-amber-200" :
                            "bg-red-50 border-red-200"
                        }`}>
                            <h4 className={`text-sm font-bold flex items-center gap-2 mb-2 ${
                                feedback.overallStatus === "success" ? "text-green-800" :
                                feedback.overallStatus === "warning" ? "text-amber-800" :
                                "text-red-800"
                            }`}>
                                {feedback.overallStatus === "success" && <CheckCircle2 className="w-4 h-4"/>}
                                {feedback.overallStatus === "warning" && <AlertTriangle className="w-4 h-4"/>}
                                {feedback.overallStatus === "error" && <XCircle className="w-4 h-4"/>}
                                数据质量分析建议
                            </h4>
                            <ul className="space-y-2">
                                {feedback.feedbacks.map((item, idx) => (
                                    <li key={idx} className="flex items-start gap-2 text-xs">
                                        <span className={`mt-0.5 w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                                            item.type === "success" ? "bg-green-500" :
                                            item.type === "warning" ? "bg-amber-500" :
                                            "bg-red-500"
                                        }`}/>
                                        <span className={
                                            item.type === "success" ? "text-green-700" :
                                            item.type === "warning" ? "text-amber-700" :
                                            "text-red-700"
                                        }>
                                            {item.msg}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                </div>
              )}
           </div>
        </div>

        <div className="bg-slate-50 border-t border-slate-200 p-4 flex justify-end gap-3">
          <button 
             onClick={handleCalculate}
             className="px-4 py-2 bg-white border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-50 transition font-medium"
          >
             计算
          </button>
          <button 
             onClick={handleApply}
             disabled={!result}
             className={`px-4 py-2 rounded-lg text-white font-medium transition shadow-sm ${
               !result ? "bg-slate-300 cursor-not-allowed" : "bg-indigo-600 hover:bg-indigo-700"
             }`}
          >
             应用结果
          </button>
        </div>
      </div>
    </div>
  );
}

// 1. Setup Panel (Step 2)
const SetupPanel = ({
  genes,
  setGenes,
  groups,
  setGroups,
}: {
  genes: Gene[];
  setGenes: React.Dispatch<React.SetStateAction<Gene[]>>;
  groups: Group[];
  setGroups: React.Dispatch<React.SetStateAction<Group[]>>;
}) => {
  const [showCalculator, setShowCalculator] = useState(false);
  const [calcTargetGeneId, setCalcTargetGeneId] = useState<string>("");

  const openCalculator = (geneId?: string) => {
    setCalcTargetGeneId(geneId || "");
    setShowCalculator(true);
  };

  const addGene = () => {
    setGenes([
      ...genes,
      { id: generateId(), name: "新基因", type: "target", efficiency: 2.0 },
    ]);
  };

  const updateGene = (id: string, field: keyof Gene, value: any) => {
    setGenes(genes.map((g) => (g.id === id ? { ...g, [field]: value } : g)));
  };

  const removeGene = (id: string) => {
    if (genes.length > 1) setGenes(genes.filter((g) => g.id !== id));
  };

  const updateGroup = (id: string, field: keyof Group, value: any) => {
    if (field === "isControl" && value === true) {
      setGroups(
        groups.map((g) => ({
          ...g,
          isControl: g.id === id,
          color: g.id === id ? "#000000" : (g.color === "#000000" ? "#fe0000" : g.color) 
        }))
      );
    } else {
      setGroups(groups.map((g) => (g.id === id ? { ...g, [field]: value } : g)));
    }
  };

  const handleEfficiencyPaste = (e: React.ClipboardEvent<HTMLInputElement>, startGeneId: string) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text");
    if (!text) return;
    
    // Split by new line
    const values = text.split(/[\r\n]+/).map(v => v.trim()).filter(v => v !== "");
    if (values.length === 0) return;

    const startIndex = genes.findIndex(g => g.id === startGeneId);
    if (startIndex === -1) return;

    const newGenes = [...genes];
    values.forEach((valStr, i) => {
      const idx = startIndex + i;
      if (idx < newGenes.length) {
        const num = parseFloat(valStr);
        if (!isNaN(num) && num >= 1 && num <= 3) {
          newGenes[idx] = { ...newGenes[idx], efficiency: num };
        }
      }
    });
    setGenes(newGenes);
  };

  const updateGeneEfficiency = (id: string, eff: number) => {
    setGenes(genes.map((g) => (g.id === id ? { ...g, efficiency: eff } : g)));
  };

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500 relative">
      <EfficiencyCalculator 
         isOpen={showCalculator} 
         onClose={() => setShowCalculator(false)}
         genes={genes}
         initialGeneId={calcTargetGeneId}
         onUpdateEfficiency={updateGeneEfficiency}
      />

      {/* Gene Setup */}
      <section className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
        <div className="flex justify-between items-center mb-4">
          <div>
            <h2 className="text-xl font-bold text-slate-800 flex items-center gap-2">
              <FlaskConical className="w-5 h-5 text-indigo-600" />
              基因参数配置
            </h2>
            <p className="text-sm text-slate-500 mt-1">
              请在此处确认基因类型（内参/目标）并填写扩增效率 (E)。支持在效率框中直接粘贴一列数据。
              <br />
              <span className="text-xs text-indigo-600 bg-indigo-50 px-1 py-0.5 rounded mt-1 inline-block">
                公式：E = 1 + 效率。 (例如：100% 效率即 1+1=2.0；90% 效率即 1+0.9=1.9)
              </span>
            </p>
          </div>
          <div className="flex gap-2">
            <button
               onClick={() => openCalculator()}
               className="flex items-center gap-2 px-3 py-1.5 text-sm bg-white border border-indigo-200 text-indigo-700 rounded-lg hover:bg-indigo-50 hover:border-indigo-300 transition-all shadow-sm font-medium"
            >
               <Calculator className="w-4 h-4"/>
               效率计算器
            </button>
            <button
                onClick={addGene}
                className="flex items-center gap-2 px-4 py-2 bg-indigo-50 text-indigo-600 rounded-lg hover:bg-indigo-100 transition-colors font-medium text-sm"
            >
                <Plus className="w-4 h-4" /> 添加基因
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-slate-500">
                <th className="pb-3 font-medium pl-2">基因名称</th>
                <th className="pb-3 font-medium">类型</th>
                <th className="pb-3 font-medium">
                  扩增效率 (E)
                  <span className="ml-1 inline-block group relative">
                    <Info className="w-3 h-3 text-slate-400 inline" />
                    <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 w-72 p-2 bg-slate-800 text-white text-xs rounded hidden group-hover:block z-10 shadow-lg leading-relaxed">
                      扩增因子 (Amplification Factor)。
                      <br/>
                      E = 10^( -1 / 斜率 ) 或 E = 1 + 效率%。
                      <br/>
                      2.0 = 100% 效率 (数量翻倍)。
                      <br/>
                      支持批量粘贴：复制Excel中的一列数值，点击第一个基因的输入框粘贴即可。
                    </span>
                  </span>
                </th>
                <th className="pb-3 font-medium w-16"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {genes.map((gene) => (
                <tr key={gene.id} className="group hover:bg-slate-50">
                  <td className="py-3 pl-2">
                    <input
                      type="text"
                      value={gene.name}
                      onChange={(e) =>
                        updateGene(gene.id, "name", e.target.value)
                      }
                      className="bg-transparent border-b border-transparent hover:border-slate-300 focus:border-indigo-500 focus:outline-none px-1 py-0.5 w-full font-medium text-slate-700"
                    />
                  </td>
                  <td className="py-3">
                    <select
                      value={gene.type}
                      onChange={(e) =>
                        updateGene(gene.id, "type", e.target.value)
                      }
                      className="bg-slate-100 border-transparent text-slate-700 text-xs rounded px-2 py-1 focus:ring-2 focus:ring-indigo-500 focus:outline-none cursor-pointer"
                    >
                      <option value="target">目标基因 (Target/GOI)</option>
                      <option value="reference">内参基因 (Reference/HKG)</option>
                    </select>
                  </td>
                  <td className="py-3">
                    <div className="flex items-center gap-2">
                        <input
                            type="number"
                            step="0.01"
                            min="1"
                            max="3"
                            value={gene.efficiency}
                            onChange={(e) =>
                                updateGene(
                                gene.id,
                                "efficiency",
                                parseFloat(e.target.value)
                                )
                            }
                            onPaste={(e) => handleEfficiencyPaste(e, gene.id)}
                            className="bg-transparent border border-slate-200 rounded px-2 py-1 w-24 text-right focus:border-indigo-500 focus:outline-none transition-all focus:ring-2 focus:ring-indigo-100"
                            placeholder="e.g. 2.0"
                        />
                        <button 
                           onClick={() => openCalculator(gene.id)}
                           className="text-slate-300 hover:text-indigo-600 transition-colors p-1 rounded hover:bg-indigo-50"
                           title="计算此基因的扩增效率"
                        >
                            <Calculator className="w-4 h-4"/>
                        </button>
                    </div>
                  </td>
                  <td className="py-3 text-right pr-2">
                    <button
                      onClick={() => removeGene(gene.id)}
                      className="text-slate-400 hover:text-red-500 transition-colors"
                      title="删除基因"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Group Detail Settings */}
      <section className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
        <div className="flex justify-between items-center mb-4">
          <div>
            <h2 className="text-xl font-bold text-slate-800 flex items-center gap-2">
              <Settings className="w-5 h-5 text-emerald-600" />
              分组颜色配置
            </h2>
            <p className="text-sm text-slate-500 mt-1">
              自定义图表中各分组的显示颜色。
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {groups.map((group) => (
            <div
              key={group.id}
              className={`flex items-center gap-4 p-4 rounded-lg border transition-all ${
                group.isControl
                  ? "bg-slate-50 border-indigo-200 shadow-sm ring-1 ring-indigo-100"
                  : "bg-white border-slate-200"
              }`}
            >
              <div className="relative">
                <input
                  type="color"
                  value={group.color}
                  onChange={(e) => updateGroup(group.id, "color", e.target.value)}
                  className="w-10 h-10 rounded cursor-pointer border-0 p-0"
                  title="点击修改颜色"
                />
              </div>
              <div className="flex-grow">
                <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">
                  {group.isControl ? "对照组 (Control)" : "处理组"}
                </div>
                <div className="font-semibold text-slate-800">{group.name}</div>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
};

// 2. Data Entry Panel (Step 1)
const DataInputPanel = ({
  genes,
  setGenes,
  groups,
  setGroups,
  samples,
  setSamples,
}: {
  genes: Gene[];
  setGenes: React.Dispatch<React.SetStateAction<Gene[]>>;
  groups: Group[];
  setGroups: React.Dispatch<React.SetStateAction<Group[]>>;
  samples: Sample[];
  setSamples: React.Dispatch<React.SetStateAction<Sample[]>>;
}) => {
  // Initialize samples if empty or mismatched
  useEffect(() => {
    if (samples.length === 0 && groups.length > 0) {
      const initialSamples: Sample[] = [];
      groups.forEach((g) => {
        for (let i = 1; i <= 3; i++) {
          initialSamples.push({
            id: generateId(),
            groupId: g.id,
            replicate: i,
            ctValues: {},
          });
        }
      });
      setSamples(initialSamples);
    }
  }, [groups.length]);

  const handleCtChange = (sampleId: string, geneId: string, val: string) => {
    const numVal = val === "" ? null : parseFloat(val);
    setSamples((prev) =>
      prev.map((s) =>
        s.id === sampleId
          ? { ...s, ctValues: { ...s.ctValues, [geneId]: numVal } }
          : s
      )
    );
  };

  const updateGeneName = (id: string, name: string) => {
    setGenes(genes.map((g) => (g.id === id ? { ...g, name } : g)));
  };

  // --- Smart Paste Functionality ---
  const handlePaste = (
    e: React.ClipboardEvent<HTMLInputElement>,
    startSampleId: string,
    geneId: string,
    groupId: string
  ) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text");
    if (!text) return;

    const matrix = text
      .split(/[\r\n]+/)
      .filter((r) => r.trim() !== "")
      .map((row) => row.split("\t").map(c => c.trim()));

    if (matrix.length === 0) return;

    const startGeneIndex = genes.findIndex((g) => g.id === geneId);
    if (startGeneIndex === -1) return;

    const maxCols = Math.max(...matrix.map((row) => row.length));
    
    // Logic to expand genes if needed
    let currentGenes = [...genes];

    if (startGeneIndex === 0) {
      const refGenes = currentGenes.filter(g => g.type === "reference");
      const keptRefs = refGenes.length >= 2 ? refGenes.slice(0, 2) : refGenes;
      const numberOfTargetsNeeded = maxCols - keptRefs.length;
      const newGeneList = [...keptRefs];
      const existingTargets = genes.filter(g => g.type === "target");

      for (let i = 0; i < Math.max(numberOfTargetsNeeded, existingTargets.length); i++) {
        if (i < existingTargets.length) {
            newGeneList.push(existingTargets[i]);
        } else if (i < numberOfTargetsNeeded) {
            newGeneList.push({
               id: generateId(),
               name: `Target Gene ${i + 1}`,
               type: "target",
               efficiency: 2.0,
            });
        }
      }
      currentGenes = newGeneList;
      setGenes(currentGenes);
    } else {
      const neededTotalGenes = startGeneIndex + maxCols;
      if (neededTotalGenes > currentGenes.length) {
        const genesToAdd = neededTotalGenes - currentGenes.length;
        for (let k = 0; k < genesToAdd; k++) {
          currentGenes.push({
            id: generateId(),
            name: `新基因 ${currentGenes.length + 1}`,
            type: "target",
            efficiency: 2.0,
          });
        }
        setGenes(currentGenes);
      }
    }

    const groupSamples = samples.filter((s) => s.groupId === groupId);
    const startSampleIndex = groupSamples.findIndex((s) => s.id === startSampleId);
    
    if (startSampleIndex === -1) return;

    let newSamples = [...samples];
    let maxRep = groupSamples.length > 0 ? Math.max(...groupSamples.map(s => s.replicate)) : 0;

    matrix.forEach((rowValues, rowIndex) => {
      const targetSampleIndex = startSampleIndex + rowIndex;
      let targetSampleId: string;

      if (targetSampleIndex < groupSamples.length) {
        targetSampleId = groupSamples[targetSampleIndex].id;
      } else {
        maxRep++;
        const newSample: Sample = {
          id: generateId(),
          groupId: groupId,
          replicate: maxRep,
          ctValues: {},
        };
        newSamples.push(newSample);
        groupSamples.push(newSample); // Keep track for local index
        targetSampleId = newSample.id;
      }

      rowValues.forEach((valStr, colIndex) => {
        const val = parseFloat(valStr);
        if (!isNaN(val)) {
          const targetGeneIndex = startGeneIndex + colIndex;
          if (targetGeneIndex < currentGenes.length) {
            const targetGeneId = currentGenes[targetGeneIndex].id;
            const sIndex = newSamples.findIndex((s) => s.id === targetSampleId);
            if (sIndex !== -1) {
              newSamples[sIndex] = {
                ...newSamples[sIndex],
                ctValues: {
                  ...newSamples[sIndex].ctValues,
                  [targetGeneId]: val,
                },
              };
            }
          }
        }
      });
    });

    setSamples(newSamples);
  };

  const addReplicate = (groupId: string) => {
    const groupSamples = samples.filter((s) => s.groupId === groupId);
    const nextRep =
      groupSamples.length > 0
        ? Math.max(...groupSamples.map((s) => s.replicate)) + 1
        : 1;
    setSamples([
      ...samples,
      {
        id: generateId(),
        groupId,
        replicate: nextRep,
        ctValues: {},
      },
    ]);
  };

  const removeSample = (sampleId: string) => {
    setSamples(samples.filter((s) => s.id !== sampleId));
  };

  const addGroup = () => {
    const newGroupId = generateId();
    // Calculate how many treatment groups exist to auto-name "TreatmentX"
    const treatmentCount = groups.filter(g => !g.isControl).length;
    
    const newGroup: Group = {
      id: newGroupId,
      name: `Treatment${treatmentCount + 1}`,
      isControl: false,
      color: COLORS[groups.length % COLORS.length],
    };
    setGroups([...groups, newGroup]);
    
    // Add default replicates for the new group
    const newSamples: Sample[] = [];
    for (let i = 1; i <= 3; i++) {
        newSamples.push({
            id: generateId(),
            groupId: newGroupId,
            replicate: i,
            ctValues: {},
        });
    }
    setSamples([...samples, ...newSamples]);
  };

  const updateGroupName = (id: string, name: string) => {
    setGroups(groups.map((g) => (g.id === id ? { ...g, name } : g)));
  };

  const setGroupControl = (id: string) => {
    setGroups(groups.map((g) => ({
      ...g,
      isControl: g.id === id,
      color: g.id === id ? "#000000" : (g.color === "#000000" ? "#fe0000" : g.color) 
    })));
  };

  const removeGroup = (id: string) => {
     if(groups.length <= 1) return;
     if(confirm("确定要删除此分组及其所有数据吗？")) {
        setGroups(groups.filter(g => g.id !== id));
        setSamples(samples.filter(s => s.groupId !== id));
     }
  };

  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden animate-in fade-in slide-in-from-bottom-4 duration-500 relative">
      <div className="p-4 border-b border-slate-200 bg-slate-50 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="font-bold text-slate-800 flex items-center gap-2">
            <FileSpreadsheet className="w-5 h-5 text-green-600" />
            步骤 1：原始数据录入
          </h2>
          <p className="text-xs text-slate-500 mt-1 flex items-center gap-1">
             <ClipboardPaste className="w-3 h-3"/> 
             支持从 Excel 直接粘贴 Ct 值。请在此处添加分组并录入数据。
          </p>
        </div>
      </div>

      <div className="overflow-x-auto pb-12">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="bg-slate-100 border-b border-slate-200 text-slate-600">
              <th className="py-3 px-4 font-semibold min-w-[200px] sticky left-0 bg-slate-100 z-10 shadow-[2px_0_5px_-2px_rgba(0,0,0,0.1)]">
                分组设置 / 样本
              </th>
              {genes.map((g) => (
                <th key={g.id} className="py-3 px-4 font-semibold text-center min-w-[120px]">
                  <div className="flex flex-col items-center gap-1">
                    <input
                      type="text"
                      value={g.name}
                      onChange={(e) => updateGeneName(g.id, e.target.value)}
                      className="text-center font-bold text-slate-700 bg-transparent border-b border-transparent hover:border-slate-300 focus:border-indigo-500 focus:outline-none w-full py-0.5 transition-all"
                      placeholder="基因名称"
                    />
                    <span
                      className={`text-[10px] px-1.5 rounded-full ${
                        g.type === "reference"
                          ? "bg-blue-100 text-blue-700"
                          : "bg-emerald-100 text-emerald-700"
                      }`}
                    >
                      {g.type === "reference" ? "内参" : "目标"}
                    </span>
                  </div>
                </th>
              ))}
              <th className="py-3 px-4 w-10"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {groups.map((group) => {
              const groupSamples = samples.filter((s) => s.groupId === group.id);
              return (
                <React.Fragment key={group.id}>
                  {/* Group Header Row */}
                  <tr className="bg-slate-50 border-t-2 border-slate-100">
                    <td
                      colSpan={genes.length + 2}
                      className="py-3 px-4 sticky left-0 z-10"
                    >
                      <div className="flex items-center gap-4 flex-wrap">
                        {/* Color Indicator */}
                        <div
                          className="w-3 h-8 rounded-full"
                          style={{ backgroundColor: group.color }}
                          title="分组颜色（可在设置中修改）"
                        />
                        
                        {/* Group Name Input */}
                        <div className="flex-grow max-w-xs">
                           <input 
                              type="text" 
                              value={group.name}
                              onChange={(e) => updateGroupName(group.id, e.target.value)}
                              className="w-full bg-white border border-slate-300 rounded px-2 py-1 font-bold text-slate-800 focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                              placeholder="分组名称"
                           />
                        </div>

                        {/* Control Toggle */}
                        <label className="flex items-center gap-2 cursor-pointer bg-white px-2 py-1 rounded border border-slate-200 hover:bg-slate-50 transition">
                            <input
                                type="radio"
                                name="controlGroupSelect"
                                checked={group.isControl}
                                onChange={() => setGroupControl(group.id)}
                                className="text-indigo-600 focus:ring-indigo-500"
                            />
                            <span className={`text-xs font-medium ${group.isControl ? "text-indigo-700" : "text-slate-500"}`}>
                                {group.isControl ? "当前对照组 (Control)" : "设为对照组"}
                            </span>
                        </label>

                        {/* Actions */}
                        <div className="flex items-center gap-2 ml-auto">
                            <button
                                onClick={() => addReplicate(group.id)}
                                className="text-indigo-600 hover:text-indigo-800 text-xs flex items-center gap-1 bg-indigo-50 px-2 py-1.5 rounded hover:bg-indigo-100 transition"
                            >
                                <Plus className="w-3 h-3" /> 添加样本
                            </button>
                            <button
                                onClick={() => removeGroup(group.id)}
                                className="text-slate-400 hover:text-red-600 p-1.5 hover:bg-red-50 rounded transition"
                                title="删除此分组"
                            >
                                <Trash2 className="w-4 h-4" />
                            </button>
                        </div>
                      </div>
                    </td>
                  </tr>

                  {/* Samples Rows */}
                  {groupSamples.map((sample) => (
                    <tr key={sample.id} className="hover:bg-slate-50 group">
                      <td className="py-2 px-4 font-medium text-slate-500 sticky left-0 bg-white group-hover:bg-slate-50 z-10 border-r border-slate-100 pl-8">
                         <span className="text-xs bg-slate-100 px-1.5 py-0.5 rounded text-slate-500">#{sample.replicate}</span>
                      </td>
                      {genes.map((gene) => (
                        <td key={gene.id} className="p-1">
                          <input
                            type="number"
                            step="0.01"
                            placeholder="-"
                            value={sample.ctValues[gene.id] ?? ""}
                            onChange={(e) =>
                              handleCtChange(sample.id, gene.id, e.target.value)
                            }
                            onPaste={(e) => handlePaste(e, sample.id, gene.id, group.id)}
                            className="w-full text-center bg-slate-50 border border-slate-200 rounded py-1.5 text-slate-700 focus:bg-white focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 focus:outline-none transition-all font-mono"
                          />
                        </td>
                      ))}
                      <td className="pr-2 text-right">
                        <button
                          onClick={() => removeSample(sample.id)}
                          className="text-slate-300 hover:text-red-500 p-1 opacity-0 group-hover:opacity-100 transition-opacity"
                          tabIndex={-1}
                          title="删除样本"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
        
        {/* Add Group Button at bottom */}
        <div className="p-4 bg-slate-50 border-t border-slate-200 flex justify-center">
            <button
                onClick={addGroup}
                className="flex items-center gap-2 px-6 py-3 bg-white border border-dashed border-slate-300 rounded-lg text-slate-600 hover:text-indigo-600 hover:border-indigo-300 hover:bg-indigo-50 transition-all font-medium shadow-sm"
            >
                <Plus className="w-5 h-5" />
                添加新的实验分组
            </button>
        </div>
      </div>
    </div>
  );
};

// 3. Analysis & Results Panel (Step 3)
const ResultsPanel = ({
  genes,
  groups,
  samples,
}: {
  genes: Gene[];
  groups: Group[];
  samples: Sample[];
}) => {
  const [results, setResults] = useState<AnalysisResult[]>([]);
  const chartRef = useRef<HTMLCanvasElement>(null);
  const chartInstance = useRef<any>(null);

  // --- Logic: Stats & Calculation ---
  useEffect(() => {
    if (genes.length === 0 || groups.length === 0 || samples.length === 0) return;

    const controlGroup = groups.find((g) => g.isControl);
    if (!controlGroup) return; 

    const refGenes = genes.filter((g) => g.type === "reference");
    const targetGenes = genes.filter((g) => g.type === "target");

    if (refGenes.length === 0) return; 

    // 1. Control Mean Ct
    const controlSamples = samples.filter((s) => s.groupId === controlGroup.id);
    const controlMeans: Record<string, number> = {};

    genes.forEach((gene) => {
      const cts = controlSamples
        .map((s) => s.ctValues[gene.id])
        .filter((v) => v !== null && v !== undefined) as number[];
      if (cts.length > 0) {
        const sum = cts.reduce((a, b) => a + b, 0);
        controlMeans[gene.id] = sum / cts.length;
      } else {
        controlMeans[gene.id] = 0; 
      }
    });

    // 2. Relative Quantity (Q)
    const sampleQ: Record<string, Record<string, number>> = {}; 

    samples.forEach((sample) => {
      sampleQ[sample.id] = {};
      genes.forEach((gene) => {
        const ct = sample.ctValues[gene.id];
        if (ct !== null && ct !== undefined && controlMeans[gene.id] !== 0) {
          const deltaCt = controlMeans[gene.id] - ct;
          sampleQ[sample.id][gene.id] = Math.pow(gene.efficiency, deltaCt);
        } else {
          sampleQ[sample.id][gene.id] = 0;
        }
      });
    });

    // 3. Normalization Factor (Geometric Mean of Refs)
    const sampleRefFactors: Record<string, number> = {}; 

    samples.forEach((sample) => {
      let product = 1;
      let count = 0;
      refGenes.forEach((rg) => {
        const q = sampleQ[sample.id][rg.id];
        if (q > 0) {
          product *= q;
          count++;
        }
      });
      sampleRefFactors[sample.id] = count > 0 ? Math.pow(product, 1 / count) : 0;
    });

    // 4. Normalized Expression & Stats
    const analysis: AnalysisResult[] = targetGenes.map((target) => {
      
      const groupDataMap: Record<string, number[]> = {};
      const statsList: GroupStatResult[] = [];

      groups.forEach((group) => {
        const groupSamples = samples.filter((s) => s.groupId === group.id);
        const values: number[] = [];

        groupSamples.forEach((sample) => {
          const qTarget = sampleQ[sample.id][target.id];
          const nf = sampleRefFactors[sample.id];
          if (qTarget > 0 && nf > 0) {
            values.push(qTarget / nf);
          }
        });

        groupDataMap[group.id] = values;

        // Descriptive Stats
        const n = values.length;
        const mean = n > 0 ? values.reduce((a, b) => a + b, 0) / n : 0;
        const variance =
          n > 1
            ? values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (n - 1)
            : 0;
        const sd = Math.sqrt(variance);
        const sem = n > 0 ? sd / Math.sqrt(n) : 0;

        statsList.push({
          groupId: group.id,
          groupName: group.name,
          meanNormalizedExpression: mean,
          sem,
          sd,
          n,
          individualValues: values,
          pValue: undefined as number | undefined,
          significance: "",
          markingLetter: "",
        });
      });

      // Statistical Testing using jStat
      let anovaPValue: number | undefined = undefined;
      
      if (typeof jStat !== 'undefined') {
        const controlValues = groupDataMap[controlGroup.id];
        
        // --- 2 Groups: Welch's t-test ---
        if (groups.length === 2) {
             const g1 = statsList[0];
             const g2 = statsList[1];
             if (g1.n > 1 && g2.n > 1) {
                const treat = g1.groupId === controlGroup.id ? g2 : g1;
                const ctrl = g1.groupId === controlGroup.id ? g1 : g2;
                try {
                  const p = calculateWelchTTest(treat.individualValues, ctrl.individualValues);
                  treat.pValue = p;
                  treat.significance = getSignificanceLabel(p);
                } catch(e) {}
             }
        } 
        // --- 3+ Groups: ANOVA + Post-Hoc Letter Marking (CLD) ---
        else if (groups.length > 2) {
            const allVectors = groups.map(g => groupDataMap[g.id]).filter(v => v.length > 1);
            // ANOVA
            if (allVectors.length === groups.length) {
               try {
                  anovaPValue = jStat.anovaftest(...allVectors); 
               } catch(e) { console.error("ANOVA error", e); }
            }

            // If ANOVA is significant (or generally we show letters anyway for trends), 
            // generate letters. Standard practice: if ANOVA ns, all 'a'.
            if (anovaPValue !== undefined) {
               if (anovaPValue < 0.05) {
                   try {
                     const markingMap = generateLetterMarkings(statsList);
                     statsList.forEach(s => s.markingLetter = markingMap[s.groupId]);
                   } catch(e) {
                      console.error("Letter generation error:", e);
                      statsList.forEach(s => s.markingLetter = "?");
                   }
               } else {
                   // No significant difference globally
                   statsList.forEach(s => s.markingLetter = "a");
               }
            }
        }
      }

      return {
        geneId: target.id,
        geneName: target.name,
        anovaPValue,
        groupResults: statsList
      };
    });

    setResults(analysis);
  }, [genes, groups, samples]);

  // --- Export Functions ---
  const downloadCSV = () => {
    if (results.length === 0) return;
    
    let csvContent = "data:text/csv;charset=utf-8,\uFEFF"; 
    // Header
    csvContent += "Gene,ANOVA P-Value (Global),Group,Mean Normalized Expression,SEM,SD,N,Comparison,Significance/Letter\n";

    results.forEach(res => {
      const anovaP = formatPValue(res.anovaPValue);
      res.groupResults.forEach(gr => {
        let sigText = "";
        let comparisonType = "";
        if (groups.length > 2) {
            sigText = gr.markingLetter || "";
            comparisonType = "Letter Marking (CLD)";
        } else {
            sigText = gr.significance || (gr.groupId === groups.find(g=>g.isControl)?.id ? "Control" : "ns");
            comparisonType = "vs Control (t-test)";
        }

        const pVal = gr.pValue !== undefined ? formatPValue(gr.pValue) : "-";

        csvContent += `"${res.geneName}",${anovaP},"${gr.groupName}",${gr.meanNormalizedExpression},${gr.sem},${gr.sd},${gr.n},"${comparisonType}","${sigText}"\n`;
      });
    });

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", "qRT-PCR_Stats_Data.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const downloadImage = () => {
    if (!chartRef.current) return;
    const link = document.createElement("a");
    // Generate high res image
    link.download = "qRT-PCR_Chart.png";
    link.href = chartRef.current.toDataURL("image/png", 1.0);
    link.click();
  };

  const downloadPDF = () => {
    // Check if jsPDF exists safely
    const jspdfLib = (window as any).jspdf;
    if (!jspdfLib) {
      alert("PDF library failed to load. Please check internet connection.");
      return;
    }
    const jsPDF = jspdfLib.jsPDF || jspdfLib;
    
    const doc = new jsPDF();
    
    // Title
    doc.setFontSize(18);
    doc.text("qRT-PCR Analysis Report", 14, 20);
    doc.setFontSize(10);
    doc.text(`Date: ${new Date().toLocaleDateString()}`, 14, 28);

    // Chart Image
    if (chartRef.current) {
       try {
         const imgData = chartRef.current.toDataURL("image/png", 1.0);
         doc.addImage(imgData, 'PNG', 14, 35, 180, 100); 
       } catch (e) { console.error("Image export error", e); }
    }

    // Table Data
    let yPos = 145;
    doc.setFontSize(12);
    doc.text("Detailed Statistics Summary", 14, yPos);
    yPos += 10;
    
    doc.setFontSize(9);
    results.forEach(res => {
      if (yPos > 270) { doc.addPage(); yPos = 20; }
      
      doc.setFont(undefined, 'bold');
      let title = `Target Gene: ${res.geneName}`;
      if (res.anovaPValue !== undefined) {
         title += ` (ANOVA P = ${formatPValue(res.anovaPValue)})`;
      }
      doc.text(title, 14, yPos);
      yPos += 6;
      doc.setFont(undefined, 'normal');
      
      const startX = 14;
      const colWidth = 35;
      
      // Header
      doc.setFillColor(240, 240, 240);
      doc.rect(startX, yPos - 4, 170, 6, 'F');
      doc.text("Group", startX + 2, yPos);
      doc.text("Mean ± SEM", startX + colWidth, yPos);
      if (groups.length > 2) {
          doc.text("Letter (CLD)", startX + colWidth * 2 + 10, yPos);
      } else {
          doc.text("P-Value (vs Ctrl)", startX + colWidth * 2 + 10, yPos);
          doc.text("Sig.", startX + colWidth * 3 + 15, yPos);
      }
      yPos += 6;

      res.groupResults.forEach(gr => {
         const meanText = `${gr.meanNormalizedExpression.toFixed(2)} ± ${gr.sem.toFixed(2)}`;
         doc.text(gr.groupName, startX + 2, yPos);
         doc.text(meanText, startX + colWidth, yPos);
         
         if (groups.length > 2) {
             // Show Letter
             doc.text(gr.markingLetter || "a", startX + colWidth * 2 + 10, yPos);
         } else {
             // Show P-value
             const pText = formatPValue(gr.pValue);
             doc.text(pText, startX + colWidth * 2 + 10, yPos);
             doc.text(gr.significance || "ns", startX + colWidth * 3 + 15, yPos);
         }
         yPos += 5;
      });
      yPos += 8; // Spacer
    });
    
    // Add footnote
    doc.setFontSize(8);
    doc.setTextColor(100);
    const methodText = groups.length > 2 
        ? "Statistics: One-way ANOVA followed by Pairwise t-test (LSD) for Letter Marking (CLD). Groups sharing a letter are not significantly different (P>0.05)."
        : "Statistics: Welch's t-test (Two-tailed, unequal variance). Error bars: SEM. * P<0.05.";
    doc.text(methodText, 14, 285);

    doc.save("qRT-PCR_Report.pdf");
  };

  // --- Charting ---
  useEffect(() => {
    if (!chartRef.current || results.length === 0 || typeof Chart === 'undefined') return;
    
    if (chartInstance.current) {
      chartInstance.current.destroy();
    }

    const ctx = chartRef.current.getContext("2d");
    if (!ctx) return;

    const labels = results.map(r => r.geneName);
    
    const datasets = groups.map((group) => {
      const dataPoints = results.map((res) => {
        const gRes = res.groupResults.find(gr => gr.groupId === group.id);
        return gRes ? gRes.meanNormalizedExpression : 0;
      });

      const semPoints = results.map((res) => {
        const gRes = res.groupResults.find(gr => gr.groupId === group.id);
        return gRes ? gRes.sem : 0;
      });
      
      // Determine what to show: Letters (>2 groups) or Stars (2 groups)
      const isMultiGroup = groups.length > 2;
      const markings = results.map((res) => {
        const gRes = res.groupResults.find(gr => gr.groupId === group.id);
        if (isMultiGroup) return gRes?.markingLetter || "";
        return gRes?.significance || "";
      });

      return {
        label: group.name,
        data: dataPoints,
        sem: semPoints,
        marking: markings,
        isLetters: isMultiGroup,
        backgroundColor: group.color,
        borderColor: group.color,
        borderWidth: 1,
      };
    });

    // Plugin for Error Bars AND Significance
    const scientificPlugin = {
      id: 'scientificPlugin',
      afterDatasetsDraw: (chart: any) => {
        const { ctx } = chart;
        chart.data.datasets.forEach((dataset: any, i: number) => {
          const meta = chart.getDatasetMeta(i);
          if (!meta.hidden && dataset.sem) {
            meta.data.forEach((element: any, index: number) => {
              const dataPoint = dataset.data[index];
              const sem = dataset.sem[index];
              const mark = dataset.marking ? dataset.marking[index] : "";
              const isLetters = dataset.isLetters;
              
              if (sem === 0 || sem === undefined) return;

              const x = element.x;
              const topY = chart.scales.y.getPixelForValue(dataPoint + sem);
              const bottomY = chart.scales.y.getPixelForValue(dataPoint - sem);

              ctx.save();
              ctx.strokeStyle = "#333333";
              ctx.lineWidth = 1.5;
              
              // Error Bar
              ctx.beginPath();
              ctx.moveTo(x, topY);
              ctx.lineTo(x, bottomY);
              ctx.stroke();

              // Caps
              const capWidth = 6;
              ctx.beginPath();
              ctx.moveTo(x - capWidth, topY);
              ctx.lineTo(x + capWidth, topY);
              ctx.moveTo(x - capWidth, bottomY);
              ctx.lineTo(x + capWidth, bottomY);
              ctx.stroke();

              // Significance / Letters
              if (mark && mark !== 'ns') {
                 ctx.fillStyle = "#000000";
                 ctx.textAlign = "center";
                 ctx.textBaseline = "bottom";
                 
                 if (isLetters) {
                    // Letters: Normal font, slightly higher
                    ctx.font = "12px Arial";
                    ctx.fillText(mark, x, topY - 5);
                 } else {
                    // Stars: Bold, larger
                    ctx.font = "bold 16px Arial";
                    ctx.fillText(mark, x, topY - 5);
                 }
              }
              
              ctx.restore();
            });
          }
        });
      }
    };

    chartInstance.current = new Chart(ctx, {
      type: "bar",
      data: {
        labels,
        datasets,
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        devicePixelRatio: 2, // High DPI for exports
        layout: {
           padding: { top: 30 } // Space for stars/letters
        },
        plugins: {
          title: {
            display: true,
            text: "相对归一化表达量 (Mean ± SEM)",
            font: { size: 16, weight: 'bold' },
            padding: 10
          },
          legend: { position: 'bottom' },
          tooltip: {
            callbacks: {
              afterLabel: function(context: any) {
                const dataset = context.dataset;
                const index = context.dataIndex;
                const sem = dataset.sem[index];
                const mark = dataset.marking[index];
                let label = `SEM: ±${sem.toFixed(3)}`;
                if(mark) label += ` (${mark})`;
                return label;
              }
            }
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            title: { 
              display: true, 
              text: 'Relative Expression',
              font: { weight: 'bold' }
            },
            grid: { color: '#f3f4f6' }
          },
          x: {
            grid: { display: false }
          }
        },
        animation: { duration: 500 }
      },
      plugins: [scientificPlugin]
    });

    return () => {
      if (chartInstance.current) {
        chartInstance.current.destroy();
      }
    };

  }, [results, groups]);

  if (results.length === 0) {
    return (
      <div className="p-12 text-center text-slate-400 bg-slate-50 rounded-xl border border-dashed border-slate-300">
        <BarChart3 className="w-12 h-12 mx-auto mb-4 opacity-50" />
        <p>请在“数据录入”页面添加样本以查看分析结果。</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      
      {/* Toolbar */}
      <div className="flex flex-col md:flex-row justify-between items-center bg-white p-4 rounded-xl shadow-sm border border-slate-200 gap-4">
         <div className="text-sm text-slate-500">
           <div className="font-bold text-slate-700 flex items-center gap-2">
             <Info className="w-4 h-4"/> 统计说明：
           </div> 
           {groups.length > 2 
             ? "One-way ANOVA + Pairwise LSD Test (Letter Marking/CLD)" 
             : "Welch's t-test (Two-tailed, Unequal Variance)"}
           <div className="text-xs text-slate-400 mt-1">
             {groups.length > 2 ? "相同字母表示无显著差异 (P>0.05)。" : "误差棒：Mean ± SEM; 显著性: * P<0.05"}
           </div>
         </div>
         <div className="flex gap-2 flex-wrap justify-end">
            <button 
               onClick={downloadCSV}
               className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors border border-slate-200"
               title="适用于 Excel"
            >
               <FileSpreadsheet className="w-4 h-4 text-green-600"/> Excel (CSV)
            </button>
            <button 
               onClick={downloadImage}
               className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors border border-slate-200"
            >
               <ImageIcon className="w-4 h-4 text-purple-600"/> 高清图片 (PNG)
            </button>
            <button 
               onClick={downloadPDF}
               className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-white bg-slate-800 hover:bg-slate-900 rounded-lg transition-colors"
            >
               <FileText className="w-4 h-4"/> 导出报告 (PDF)
            </button>
         </div>
      </div>

      {/* Charts */}
      <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200 h-[500px]">
        <canvas ref={chartRef} />
      </div>

      {/* Data Table */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="p-4 bg-slate-50 border-b border-slate-200 font-bold text-slate-700 flex justify-between items-center">
          <span>详细统计数据</span>
          {typeof jStat === 'undefined' && (
            <span className="text-xs text-red-500 flex items-center gap-1">
              <Info className="w-3 h-3"/> 统计库未加载
            </span>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead>
              <tr className="border-b border-slate-100 text-slate-500">
                <th className="py-3 px-4">基因</th>
                <th className="py-3 px-4">分组</th>
                <th className="py-3 px-4 text-right">Mean ± SEM</th>
                <th className="py-3 px-4 text-right">
                    {groups.length > 2 ? "字母标记 (CLD)" : "P-Value (vs Ctrl)"}
                </th>
                <th className="py-3 px-4 text-right">样本数 (N)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {results.map((res) =>
                res.groupResults.map((gr, idx) => (
                  <tr key={`${res.geneId}-${gr.groupId}`} className="hover:bg-slate-50">
                    {idx === 0 && (
                      <td rowSpan={res.groupResults.length} className="py-3 px-4 font-medium border-r border-slate-100 bg-white align-middle">
                        <div className="flex flex-col">
                           <span className="text-base font-bold text-slate-800">{res.geneName}</span>
                           {res.anovaPValue !== undefined && (
                             <span className="text-[10px] text-slate-400 mt-1 bg-slate-50 px-1.5 py-0.5 rounded border border-slate-200 inline-block w-fit">
                               ANOVA P = {formatPValue(res.anovaPValue)}
                             </span>
                           )}
                        </div>
                      </td>
                    )}
                    <td className="py-3 px-4 flex items-center gap-2">
                       <div className="w-2 h-2 rounded-full" style={{ backgroundColor: groups.find(g=>g.id === gr.groupId)?.color }}></div>
                       {gr.groupName}
                    </td>
                    <td className="py-3 px-4 text-right font-mono">
                       {gr.meanNormalizedExpression.toFixed(3)} <span className="text-slate-400 text-xs">± {gr.sem.toFixed(3)}</span>
                    </td>
                    <td className="py-3 px-4 text-right font-mono text-slate-600">
                       {groups.length > 2 ? (
                         // Letter Marking Display
                         <span className="font-bold text-slate-800 bg-yellow-50 px-2 py-0.5 rounded border border-yellow-100">
                           {gr.markingLetter || "a"}
                         </span>
                       ) : (
                         // 2-Group T-test Display
                         gr.pValue !== undefined ? (
                           <>
                             {formatPValue(gr.pValue)} 
                             <span className={`ml-2 inline-block w-8 font-bold text-left ${gr.pValue < 0.05 ? "text-red-500" : "text-slate-300"}`}>
                               {gr.significance}
                             </span>
                           </>
                         ) : <span className="text-slate-300">-</span>
                       )}
                    </td>
                    <td className="py-3 px-4 text-right text-slate-400">{gr.n}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

// --- Main App Layout ---

const App = () => {
  const [activeTab, setActiveTab] = useState<"data" | "setup" | "results">("data");
  
  // Global State
  const [genes, setGenes] = useState<Gene[]>(DEFAULT_GENES);
  const [groups, setGroups] = useState<Group[]>(DEFAULT_GROUPS);
  const [samples, setSamples] = useState<Sample[]>([]);

  // Simple dummy data loader for demo purposes
  const loadDemoData = () => {
    const newSamples: Sample[] = [];
    // Control Group (Baseline)
    newSamples.push({ id: generateId(), groupId: "grp_ctrl", replicate: 1, ctValues: { g_bactin: 22.1, g_s27: 24.5, g_target1: 28.0 } });
    newSamples.push({ id: generateId(), groupId: "grp_ctrl", replicate: 2, ctValues: { g_bactin: 22.3, g_s27: 24.4, g_target1: 28.2 } });
    newSamples.push({ id: generateId(), groupId: "grp_ctrl", replicate: 3, ctValues: { g_bactin: 22.0, g_s27: 24.6, g_target1: 27.9 } });
    
    // Treatment 1 (Significant Increase)
    newSamples.push({ id: generateId(), groupId: "grp_treat1", replicate: 1, ctValues: { g_bactin: 22.2, g_s27: 24.5, g_target1: 26.1 } });
    newSamples.push({ id: generateId(), groupId: "grp_treat1", replicate: 2, ctValues: { g_bactin: 22.1, g_s27: 24.3, g_target1: 25.9 } });
    newSamples.push({ id: generateId(), groupId: "grp_treat1", replicate: 3, ctValues: { g_bactin: 22.4, g_s27: 24.6, g_target1: 26.0 } });
    
    setSamples(newSamples);
    setActiveTab("data");
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans pb-20">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-30">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="bg-indigo-600 p-2 rounded-lg">
              <FlaskConical className="w-5 h-5 text-white" />
            </div>
            <h1 className="text-xl font-bold text-slate-800 tracking-tight">qRT-PCR 智能分析</h1>
          </div>
          <div className="flex items-center gap-4">
            <button 
              onClick={loadDemoData}
              className="text-xs font-medium text-slate-500 hover:text-indigo-600 transition-colors"
            >
              加载演示数据
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        
        {/* Navigation Tabs */}
        <div className="flex justify-center mb-8">
          <div className="bg-white p-1 rounded-xl border border-slate-200 shadow-sm inline-flex">
            <button
              onClick={() => setActiveTab("data")}
              className={`px-6 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-2 ${
                activeTab === "data"
                  ? "bg-indigo-600 text-white shadow-sm"
                  : "text-slate-500 hover:bg-slate-50 hover:text-slate-700"
              }`}
            >
              <FileSpreadsheet className="w-4 h-4" /> 1. 数据录入
            </button>
            <button
              onClick={() => setActiveTab("setup")}
              className={`px-6 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-2 ${
                activeTab === "setup"
                  ? "bg-indigo-600 text-white shadow-sm"
                  : "text-slate-500 hover:bg-slate-50 hover:text-slate-700"
              }`}
            >
              <Settings className="w-4 h-4" /> 2. 实验参数设置
            </button>
            <button
              onClick={() => setActiveTab("results")}
              className={`px-6 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-2 ${
                activeTab === "results"
                  ? "bg-indigo-600 text-white shadow-sm"
                  : "text-slate-500 hover:bg-slate-50 hover:text-slate-700"
              }`}
            >
              <BarChart3 className="w-4 h-4" /> 3. 分析结果
            </button>
          </div>
        </div>

        {/* Dynamic Content */}
        {activeTab === "data" && (
          <DataInputPanel
            genes={genes}
            setGenes={setGenes}
            groups={groups}
            setGroups={setGroups}
            samples={samples}
            setSamples={setSamples}
          />
        )}

        {activeTab === "setup" && (
          <SetupPanel
            genes={genes}
            setGenes={setGenes}
            groups={groups}
            setGroups={setGroups}
          />
        )}

        {activeTab === "results" && (
          <ResultsPanel
            genes={genes}
            groups={groups}
            samples={samples}
          />
        )}

      </main>
    </div>
  );
};

const root = createRoot(document.getElementById("root")!);
root.render(<App />);