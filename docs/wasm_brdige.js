"use strict";

(function (globalScope) {
    var wasmModule = null;
    var wasmFactory = null;

    function resolveFactory() {
        if (wasmFactory) {
            return wasmFactory;
        }

        if (typeof NetRouteSim === "function") {
            wasmFactory = NetRouteSim;
            return wasmFactory;
        }

        if (globalScope && typeof globalScope.NetRouteSim === "function") {
            wasmFactory = globalScope.NetRouteSim;
            return wasmFactory;
        }

        if (typeof require === "function") {
            try {
                wasmFactory = require("./netroute.js");
                if (wasmFactory && typeof wasmFactory.default === "function") {
                    wasmFactory = wasmFactory.default;
                }
            } catch (error) {
                wasmFactory = null;
            }
        }

        if (typeof wasmFactory !== "function") {
            throw new Error("NetRouteSim factory is not available. Load web/netroute.js first.");
        }

        return wasmFactory;
    }

    async function initWasm() {
        if (wasmModule) {
            return wasmModule;
        }

        var factory = resolveFactory();
        wasmModule = await factory();
        return wasmModule;
    }

    function ensureInitialized() {
        if (!wasmModule) {
            throw new Error("WASM module is not initialized. Call initWasm() first.");
        }
        return wasmModule;
    }

    function parseEdges(edges) {
        if (!Array.isArray(edges)) {
            throw new Error("edges must be an array");
        }

        if (edges.length === 0) {
            return [];
        }

        var flat = [];
        if (Array.isArray(edges[0])) {
            for (var i = 0; i < edges.length; i++) {
                var entry = edges[i];
                if (!Array.isArray(entry) || entry.length !== 3) {
                    throw new Error("each edge must have [src, dest, weight]");
                }
                flat.push(entry[0], entry[1], entry[2]);
            }
            return flat;
        }

        if (edges.length % 3 !== 0) {
            throw new Error("flat edge array length must be a multiple of 3");
        }

        for (var j = 0; j < edges.length; j++) {
            flat.push(edges[j]);
        }
        return flat;
    }

    function loadGraph(edges, nodeCount) {
        var module = ensureInitialized();
        if (!Number.isInteger(nodeCount) || nodeCount <= 0) {
            throw new Error("nodeCount must be a positive integer");
        }

        var flatEdges = parseEdges(edges);
        var edgeCount = flatEdges.length / 3;
        var byteLength = flatEdges.length * 4;
        var edgePtr = 0;

        if (byteLength > 0) {
            edgePtr = module._malloc(byteLength);
            if (!edgePtr) {
                throw new Error("malloc failed while preparing edge data");
            }
            module.HEAP32.set(flatEdges, edgePtr >> 2);
        }

        try {
            return module._wasm_load_graph(edgePtr, edgeCount, nodeCount) === 1;
        } finally {
            if (edgePtr) {
                module._free(edgePtr);
            }
        }
    }

    function readMstResult(module, resultPtr) {
        var base = resultPtr >> 2;
        var edgeCount = module.HEAP32[base];
        var edges = [];

        for (var i = 0; i < edgeCount; i++) {
            var offset = base + 1 + i * 3;
            edges.push({
                src: module.HEAP32[offset],
                dest: module.HEAP32[offset + 1],
                weight: module.HEAP32[offset + 2]
            });
        }

        return {
            edgeCount: edgeCount,
            edges: edges,
            totalCost: module._wasm_get_mst_cost()
        };
    }

    function runKruskal() {
        var module = ensureInitialized();
        var resultPtr = module._wasm_run_kruskal();
        if (!resultPtr) {
            return null;
        }

        try {
            return readMstResult(module, resultPtr);
        } finally {
            module._wasm_free_result(resultPtr);
        }
    }

    function runPrim() {
        var module = ensureInitialized();
        var resultPtr = module._wasm_run_prim();
        if (!resultPtr) {
            return null;
        }

        try {
            return readMstResult(module, resultPtr);
        } finally {
            module._wasm_free_result(resultPtr);
        }
    }

    function runDijkstra(src, dest) {
        var module = ensureInitialized();
        if (!Number.isInteger(src) || !Number.isInteger(dest)) {
            throw new Error("src and dest must be integers");
        }

        var resultPtr = module._wasm_run_dijkstra(src, dest);
        if (!resultPtr) {
            return null;
        }

        try {
            var base = resultPtr >> 2;
            var pathLength = module.HEAP32[base];
            var path = [];

            for (var i = 0; i < pathLength; i++) {
                path.push(module.HEAP32[base + 1 + i]);
            }

            return {
                reachable: pathLength > 0,
                pathLength: pathLength,
                path: path
            };
        } finally {
            module._wasm_free_result(resultPtr);
        }
    }

    var api = {
        initWasm: initWasm,
        loadGraph: loadGraph,
        runKruskal: runKruskal,
        runPrim: runPrim,
        runDijkstra: runDijkstra
    };

    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    }

    if (globalScope) {
        globalScope.NetRouteWasmBridge = api;
        globalScope.initWasm = initWasm;
        globalScope.loadGraph = loadGraph;
        globalScope.runKruskal = runKruskal;
        globalScope.runPrim = runPrim;
        globalScope.runDijkstra = runDijkstra;
    }
})(typeof globalThis !== "undefined" ? globalThis : this);
