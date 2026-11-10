import React, { useRef, useEffect, useState } from 'react';
import { Share2, ZoomIn, ZoomOut, RotateCcw, Filter, Eye, ArrowRight, BookOpen } from 'lucide-react';
import { GraphLink, GraphNode, KnowledgeDoc } from '../../types';
import { storage } from '../../services/storage';

interface KnowledgeGraphProps {
  onSelectDoc: (doc: KnowledgeDoc) => void;
}

export const KnowledgeGraph: React.FC<KnowledgeGraphProps> = ({ onSelectDoc }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hoveredNode, setHoveredNode] = useState<GraphNode | null>(null);
  const [showTags, setShowTags] = useState(true);
  const [selectedCategory, setSelectedCategory] = useState<string>('all');

  const graphDataRef = useRef<{ nodes: (GraphNode & { x: number; y: number; vx: number; vy: number })[]; links: GraphLink[] }>({
    nodes: [],
    links: [],
  });

  const transformRef = useRef<{ x: number; y: number; k: number }>({ x: 0, y: 0, k: 1 });
  const isDraggingRef = useRef(false);
  const draggedNodeRef = useRef<(GraphNode & { x: number; y: number; vx: number; vy: number }) | null>(null);
  const lastMousePosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  // Color mapping by category
  const categoryColors: Record<string, string> = {
    '架构与系统': '#0284c7',
    '前端与工程': '#16a34a',
    '认知与方法论': '#d97706',
    '商业与战略': '#7c3aed',
    '个人复盘': '#e11d48',
    'Tag': '#64748b',
  };

  useEffect(() => {
    const raw = storage.getGraphData();
    const width = 900;
    const height = 550;

    // Initialize node positions in a circle/radial distribution
    const nodes = raw.nodes.map((n, i) => {
      const angle = (i / raw.nodes.length) * Math.PI * 2;
      const radius = 120 + Math.random() * 100;
      return {
        ...n,
        x: width / 2 + Math.cos(angle) * radius,
        y: height / 2 + Math.sin(angle) * radius,
        vx: 0,
        vy: 0,
      };
    });

    graphDataRef.current = {
      nodes,
      links: raw.links,
    };
  }, []);

  const hoveredNodeIdRef = useRef<string | null>(null);
  const dimensionsRef = useRef<{ width: number; height: number; dpr: number }>({
    width: 900,
    height: 580,
    dpr: typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1,
  });

  // ResizeObserver to size canvas without clearing during animation tick
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const container = canvas.parentElement;
    if (!container) return;

    const updateSize = () => {
      const rect = container.getBoundingClientRect();
      const cssWidth = Math.floor(rect.width) || 900;
      const cssHeight = Math.floor(rect.height) || 580;
      const dpr = window.devicePixelRatio || 1;

      canvas.width = Math.floor(cssWidth * dpr);
      canvas.height = Math.floor(cssHeight * dpr);
      dimensionsRef.current = { width: cssWidth, height: cssHeight, dpr };
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(container);

    const handleGlobalMouseUp = () => {
      isDraggingRef.current = false;
      draggedNodeRef.current = null;
    };
    window.addEventListener('mouseup', handleGlobalMouseUp);

    return () => {
      observer.disconnect();
      window.removeEventListener('mouseup', handleGlobalMouseUp);
    };
  }, []);

  // Animation & Physics Loop with HiDPI / Retina Crisp Rendering
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrameId: number;

    const tick = () => {
      const { width: cssWidth, height: cssHeight, dpr } = dimensionsRef.current;
      const { nodes, links } = graphDataRef.current;

      // Filter active nodes
      const activeNodes = nodes.filter(n => {
        if (!showTags && n.type === 'tag') return false;
        if (selectedCategory !== 'all' && n.category !== selectedCategory && n.type === 'doc') return false;
        return true;
      });

      const activeNodeIds = new Set(activeNodes.map(n => n.id));
      const activeLinks = links.filter(l => activeNodeIds.has(l.source) && activeNodeIds.has(l.target));

      // Force simulation (center gravity & repulsion)
      for (let i = 0; i < activeNodes.length; i++) {
        const a = activeNodes[i];
        if (a === draggedNodeRef.current) continue;

        // Fallback guard against NaN
        if (!isFinite(a.x) || !isFinite(a.y)) {
          a.x = cssWidth / 2;
          a.y = cssHeight / 2;
          a.vx = 0;
          a.vy = 0;
        }

        // Center gravity towards logical center
        a.vx += (cssWidth / 2 - a.x) * 0.0004;
        a.vy += (cssHeight / 2 - a.y) * 0.0004;

        // Repulsion between nodes
        for (let j = i + 1; j < activeNodes.length; j++) {
          const b = activeNodes[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          if (dist < 190) {
            const force = (190 - dist) / 190;
            const fx = (dx / dist) * force * 0.38;
            const fy = (dy / dist) * force * 0.38;
            a.vx -= fx;
            a.vy -= fy;
            b.vx += fx;
            b.vy += fy;
          }
        }
      }

      // Link attraction
      const nodeMap = new Map(activeNodes.map(n => [n.id, n]));
      activeLinks.forEach(link => {
        const source = nodeMap.get(link.source);
        const target = nodeMap.get(link.target);
        if (source && target) {
          const dx = target.x - source.x;
          const dy = target.y - source.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const force = (dist - 110) * 0.004;
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          if (source !== draggedNodeRef.current) {
            source.vx += fx;
            source.vy += fy;
          }
          if (target !== draggedNodeRef.current) {
            target.vx -= fx;
            target.vy -= fy;
          }
        }
      });

      // Position update & friction
      activeNodes.forEach(node => {
        if (node !== draggedNodeRef.current) {
          node.x += node.vx;
          node.y += node.vy;
          node.vx *= 0.88;
          node.vy *= 0.88;
        }
      });

      // Render Canvas with DPR scaling for razor-sharp visual fidelity
      ctx.save();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.scale(dpr, dpr);

      const isDark = document.documentElement.classList.contains('dark');

      // Apply pan & zoom
      const { x: panX, y: panY, k: scale } = transformRef.current;
      ctx.translate(panX, panY);
      ctx.scale(scale, scale);

      // Draw links
      const activeHoveredId = hoveredNodeIdRef.current;
      activeLinks.forEach(link => {
        const source = nodeMap.get(link.source);
        const target = nodeMap.get(link.target);
        if (source && target) {
          const isConnected = activeHoveredId && (link.source === activeHoveredId || link.target === activeHoveredId);
          ctx.beginPath();
          ctx.moveTo(source.x, source.y);
          ctx.lineTo(target.x, target.y);
          if (isConnected) {
            ctx.strokeStyle = isDark ? '#60a5fa' : '#2563eb';
            ctx.lineWidth = 2.5;
          } else {
            ctx.strokeStyle = isDark ? 'rgba(255, 255, 255, 0.16)' : 'rgba(15, 23, 42, 0.12)';
            ctx.lineWidth = 1;
          }
          ctx.stroke();
        }
      });

      // Draw nodes
      activeNodes.forEach(node => {
        const isHovered = activeHoveredId === node.id;
        const color = categoryColors[node.category] || '#64748b';
        const radius = node.type === 'doc' ? node.val : 5.5;

        // Hover halo / glow (High contrast in both light & dark modes)
        if (isHovered) {
          ctx.beginPath();
          ctx.arc(node.x, node.y, radius + 8, 0, Math.PI * 2);
          ctx.fillStyle = isDark ? 'rgba(96, 165, 250, 0.28)' : 'rgba(37, 99, 235, 0.18)';
          ctx.fill();
        }

        // Node circle fill
        ctx.beginPath();
        ctx.arc(node.x, node.y, isHovered ? radius + 2.5 : radius, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();

        // Node border: Crisp high-contrast in both modes, never washed-out white in light mode
        ctx.beginPath();
        ctx.arc(node.x, node.y, isHovered ? radius + 2.5 : radius, 0, Math.PI * 2);
        ctx.strokeStyle = isDark 
          ? (isHovered ? '#ffffff' : 'rgba(255, 255, 255, 0.45)') 
          : (isHovered ? '#0f172a' : 'rgba(15, 23, 42, 0.2)');
        ctx.lineWidth = isHovered ? 2.5 : 1.5;
        ctx.stroke();

        // Node label
        const fontSize = node.type === 'doc' ? (isHovered ? '12px' : '11px') : '10px';
        ctx.font = `${isHovered ? '700' : (node.type === 'doc' ? '600' : '500')} ${fontSize} 'Plus Jakarta Sans', system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';

        const labelY = node.y + (isHovered ? radius + 8 : radius + 4);

        // When hovered, draw a high-contrast label pill badge on canvas for 100% legibility
        if (isHovered) {
          const textMetrics = ctx.measureText(node.label);
          const pillWidth = textMetrics.width + 14;
          const pillHeight = 22;
          const pillX = node.x - pillWidth / 2;
          const pillY = labelY - 3;

          ctx.save();
          ctx.beginPath();
          if (typeof ctx.roundRect === 'function') {
            ctx.roundRect(pillX, pillY, pillWidth, pillHeight, 5);
          } else {
            ctx.rect(pillX, pillY, pillWidth, pillHeight);
          }
          // In light mode: deep slate background; in dark mode: pure white background
          ctx.fillStyle = isDark ? '#ffffff' : '#0f172a';
          ctx.fill();

          ctx.fillStyle = isDark ? '#0f172a' : '#ffffff';
          ctx.fillText(node.label, node.x, labelY + 1);
          ctx.restore();
        } else {
          ctx.fillStyle = isDark ? '#94a3b8' : '#334155';
          ctx.fillText(node.label, node.x, labelY);
        }
      });

      ctx.restore();

      animationFrameId = requestAnimationFrame(tick);
    };

    tick();
    return () => cancelAnimationFrame(animationFrameId);
  }, [showTags, selectedCategory]);

  // Handle canvas mouse events (Pan, Drag node, Hover, Click)
  const getCanvasMousePos = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const clientX = e.clientX - rect.left;
    const clientY = e.clientY - rect.top;

    const { x: panX, y: panY, k: scale } = transformRef.current;
    const safeScale = scale || 1;
    return {
      x: (clientX - panX) / safeScale,
      y: (clientY - panY) / safeScale,
      rawX: clientX,
      rawY: clientY,
    };
  };

  // High-visibility black cursors for light theme
  const BLACK_CURSOR_DEFAULT = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Cpath fill='%23000000' stroke='%23ffffff' stroke-width='1.5' stroke-linejoin='round' d='M4 3l7.5 17 2.5-6.5 6.5-2.5L4 3z'/%3E%3C/svg%3E") 4 3, default`;
  const BLACK_CURSOR_POINTER = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Cpath fill='%23000000' stroke='%23ffffff' stroke-width='1.2' d='M9 11.24V7.5a2.5 2.5 0 0 1 5 0v3.74c1.21-.81 2-1.92 2-3.24a4.5 4.5 0 0 0-9 0c0 1.32.79 2.43 2 3.24zM10 2a2 2 0 0 0-2 2v7.1a2 2 0 0 0-1.2.4L5.1 13a1.5 1.5 0 0 0-.4 1.5l1.6 4.3A4 4 0 0 0 10 21.5h6a4 4 0 0 0 4-4V11a2 2 0 0 0-2-2h-1V9a2 2 0 0 0-2-2h-1V4a2 2 0 0 0-2-2h-2z'/%3E%3C/svg%3E") 8 2, pointer`;
  const BLACK_CURSOR_GRAB = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Cpath fill='%23000000' stroke='%23ffffff' stroke-width='1.2' d='M8 4a2 2 0 0 1 4 0v4h1a2 2 0 0 1 4 0v2h1a2 2 0 0 1 4 0v5a7 7 0 0 1-7 7H11a7 7 0 0 1-7-7v-6a2 2 0 0 1 4 0v2h1V4z'/%3E%3C/svg%3E") 10 10, grab`;
  const BLACK_CURSOR_GRABBING = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Ccircle cx='12' cy='12' r='8' fill='%23000000' stroke='%23ffffff' stroke-width='1.5'/%3E%3C/svg%3E") 12 12, grabbing`;

  const applyCursor = (state: 'pointer' | 'grab' | 'grabbing' | 'default') => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const isDark = document.documentElement.classList.contains('dark');
    if (isDark) {
      canvas.style.cursor = state;
    } else {
      if (state === 'pointer') canvas.style.cursor = BLACK_CURSOR_POINTER;
      else if (state === 'grabbing') canvas.style.cursor = BLACK_CURSOR_GRABBING;
      else if (state === 'grab') canvas.style.cursor = BLACK_CURSOR_GRAB;
      else canvas.style.cursor = BLACK_CURSOR_DEFAULT;
    }
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const pos = getCanvasMousePos(e);
    const nodes = graphDataRef.current.nodes;

    // Check if clicked a node
    for (const node of nodes) {
      const dx = node.x - pos.x;
      const dy = node.y - pos.y;
      if (Math.sqrt(dx * dx + dy * dy) <= (node.val || 10) + 6) {
        draggedNodeRef.current = node;
        applyCursor('grabbing');
        return;
      }
    }

    // Otherwise pan canvas
    isDraggingRef.current = true;
    lastMousePosRef.current = { x: e.clientX, y: e.clientY };
    applyCursor('grabbing');
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const pos = getCanvasMousePos(e);

    if (draggedNodeRef.current) {
      draggedNodeRef.current.x = pos.x;
      draggedNodeRef.current.y = pos.y;
      draggedNodeRef.current.vx = 0;
      draggedNodeRef.current.vy = 0;
      applyCursor('grabbing');
      return;
    }

    if (isDraggingRef.current) {
      const dx = e.clientX - lastMousePosRef.current.x;
      const dy = e.clientY - lastMousePosRef.current.y;
      transformRef.current.x += dx;
      transformRef.current.y += dy;
      lastMousePosRef.current = { x: e.clientX, y: e.clientY };
      applyCursor('grabbing');
      return;
    }

    // Hover check
    const nodes = graphDataRef.current.nodes;
    let found: GraphNode | null = null;
    for (const node of nodes) {
      const dx = node.x - pos.x;
      const dy = node.y - pos.y;
      if (Math.sqrt(dx * dx + dy * dy) <= (node.val || 10) + 6) {
        found = node;
        break;
      }
    }

    const nextId = found ? found.id : null;
    if (nextId !== hoveredNodeIdRef.current) {
      hoveredNodeIdRef.current = nextId;
      setHoveredNode(found);
    }

    applyCursor(found ? 'pointer' : 'grab');
  };

  const handleMouseUp = () => {
    if (draggedNodeRef.current) {
      draggedNodeRef.current = null;
    }
    isDraggingRef.current = false;
    applyCursor(hoveredNodeIdRef.current ? 'pointer' : 'grab');
  };

  const handleMouseLeave = () => {
    isDraggingRef.current = false;
    draggedNodeRef.current = null;
    if (hoveredNodeIdRef.current !== null) {
      hoveredNodeIdRef.current = null;
      setHoveredNode(null);
    }
    applyCursor('default');
  };

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const pos = getCanvasMousePos(e);
    const nodes = graphDataRef.current.nodes;

    for (const node of nodes) {
      const dx = node.x - pos.x;
      const dy = node.y - pos.y;
      if (Math.sqrt(dx * dx + dy * dy) <= (node.val || 10) + 6) {
        if (node.type === 'doc') {
          const doc = storage.getDocById(node.id);
          if (doc) onSelectDoc(doc);
        }
        return;
      }
    }
  };

  const handleZoom = (delta: number) => {
    transformRef.current.k = Math.max(0.4, Math.min(2.5, transformRef.current.k + delta));
  };

  const handleResetView = () => {
    transformRef.current = { x: 0, y: 0, k: 1 };
  };

  const categories = storage.getCategories();

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-neutral-200 dark:border-neutral-800">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-neutral-900 dark:text-neutral-100 flex items-center gap-2">
            <Share2 className="w-6 h-6 text-blue-600 dark:text-blue-400" />
            <span>双脑知识全景图谱 (Knowledge Graph)</span>
          </h1>
          <p className="text-xs text-neutral-500 mt-1">
            基于 [[WikiLinks]] 双向链接与知识标签构建的可视化思维拓扑，点击任意节点直接阅读
          </p>
        </div>

        {/* Toolbar Controls */}
        <div className="flex items-center gap-2">
          {/* Category Filter */}
          <select
            value={selectedCategory}
            onChange={e => setSelectedCategory(e.target.value)}
            className="px-2.5 py-1.5 text-xs bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg outline-none"
          >
            <option value="all">全领域节点</option>
            {categories.map(c => (
              <option key={c.id} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>

          {/* Toggle Tags */}
          <button
            onClick={() => setShowTags(!showTags)}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors flex items-center gap-1.5 ${
              showTags
                ? 'bg-neutral-900 text-white dark:bg-white dark:text-neutral-900'
                : 'bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400'
            }`}
          >
            <Eye className="w-3.5 h-3.5" />
            <span>标签连接</span>
          </button>

          {/* Zoom controls */}
          <div className="flex items-center gap-1 bg-neutral-100 dark:bg-neutral-800 p-1 rounded-lg">
            <button
              onClick={() => handleZoom(0.15)}
              className="p-1 text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white"
              title="放大"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => handleZoom(-0.15)}
              className="p-1 text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white"
              title="缩小"
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={handleResetView}
              className="p-1 text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white"
              title="重置视角"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Canvas Viewport */}
      <div 
        className="relative w-full h-[580px] bg-neutral-50/70 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-2xl overflow-hidden shadow-xs"
        style={{ cursor: BLACK_CURSOR_GRAB }}
      >
        
        <canvas
          ref={canvasRef}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseLeave}
          onClick={handleClick}
          className="w-full h-full block"
        />

        {/* Legend Overlay */}
        <div className="absolute bottom-4 left-4 p-3 rounded-xl bg-white/95 dark:bg-neutral-950/95 backdrop-blur-md border border-neutral-200 dark:border-neutral-800 text-[11px] space-y-1.5 shadow-sm">
          <div className="font-semibold text-neutral-500 uppercase tracking-wider text-[10px] mb-1">
            图谱图例
          </div>
          {Object.entries(categoryColors).map(([cat, col]) => (
            <div key={cat} className="flex items-center gap-2 text-neutral-700 dark:text-neutral-300">
              <span className="w-2.5 h-2.5 rounded-full shrink-0 shadow-2xs" style={{ backgroundColor: col }} />
              <span>{cat}</span>
            </div>
          ))}
        </div>

        {/* Hover Tooltip Overlay (Deep contrast in both light and dark modes) */}
        {hoveredNode && (
          <div className="absolute top-4 right-4 max-w-xs p-3.5 rounded-xl bg-neutral-900 text-white dark:bg-neutral-950 dark:text-neutral-100 border border-neutral-800 shadow-xl space-y-1.5 animate-fade-in pointer-events-none z-20">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-mono uppercase tracking-wider text-neutral-400">
                {hoveredNode.type === 'doc' ? '知识文献' : '关联标签'}
              </span>
              <span 
                className="w-2.5 h-2.5 rounded-full shrink-0" 
                style={{ backgroundColor: categoryColors[hoveredNode.category] || '#64748b' }} 
              />
            </div>
            <h4 className="font-bold text-white text-sm leading-snug">
              {hoveredNode.label}
            </h4>
            <div className="text-[11px] text-neutral-400 flex items-center gap-1.5">
              <span>所属领域：</span>
              <span className="text-neutral-200 font-medium">{hoveredNode.category}</span>
            </div>
            {hoveredNode.type === 'doc' && (
              <p className="text-[11px] text-blue-400 pt-1 font-medium flex items-center gap-1">
                <span>点击节点进入阅读</span>
                <span>→</span>
              </p>
            )}
          </div>
        )}

      </div>

    </div>
  );
};
